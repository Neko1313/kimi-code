import { AsyncLocalStorage } from 'node:async_hooks';
import type { HookFailure, Origin } from './mods';

const CORE_ORIGIN: Origin = Object.freeze({ plugin: 'engine', tier: 'core' });
export const MODS_HOOK_BUDGET = Object.freeze({ ms: 10000, catchMs: 1000, lingerMs: 5000 });

interface ExecutionState {
  origin: Origin;
  active: ReadonlySet<string>;
  caught: ReadonlySet<string>;
  scope?: HookScope;
  rewritten?: boolean;
  lent?: boolean;
  detached?: boolean;
}

export class HookTimeout extends Error {}

export class HookScope {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private startedAt = performance.now();
  private spent = 0;
  private paused = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expire!: (error: unknown) => void;

  constructor(readonly ms: number, signal: AbortSignal, private readonly onLingering: () => void) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
  }

  get remainingMs(): number {
    return Math.max(0, this.ms - this.spent - (this.paused === 0 && !this.closed ? performance.now() - this.startedAt : 0));
  }

  assertActive(): void {
    this.signal.throwIfAborted();
    if (this.closed) throw new Error('Mod hook has already settled');
    if (this.remainingMs <= 0) throw new HookTimeout('Mod hook exceeded its own-time budget');
  }

  pause(): () => void {
    this.assertActive();
    if (this.paused++ === 0) {
      this.spent += performance.now() - this.startedAt;
      clearTimeout(this.timer);
    }
    let resumed = false;
    return () => {
      if (resumed || this.closed) return;
      resumed = true;
      if (--this.paused === 0) { this.startedAt = performance.now(); this.arm(); }
    };
  }

  async run<T>(work: () => T | Promise<T>): Promise<T> {
    let abort: (() => void) | undefined;
    let settled = false;
    let linger: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        this.expire = reject;
        abort = () => { reject(this.signal.reason); };
        this.signal.addEventListener('abort', abort, { once: true });
        this.assertActive();
        this.arm();
      });
      const result = Promise.resolve().then(() => { this.assertActive(); return work(); }).then(value => { this.assertActive(); return value; }).finally(() => { settled = true; clearTimeout(linger); });
      return await Promise.race([timeout, result]);
    } finally {
      if (abort !== undefined) this.signal.removeEventListener('abort', abort);
      clearTimeout(this.timer);
      this.spent = this.ms - this.remainingMs;
      this.closed = true;
      this.controller.abort(new Error('Mod hook settled'));
      if (!settled) { linger = setTimeout(this.onLingering, MODS_HOOK_BUDGET.lingerMs); linger.unref(); }
    }
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const error = new HookTimeout('Mod hook exceeded its own-time budget');
      this.expire(error);
      this.controller.abort(error);
    }, this.remainingMs);
  }
}

export class RuntimeExecution {
  private readonly storage = new AsyncLocalStorage<ExecutionState>();

  get origin(): Origin { return this.storage.getStore()?.origin ?? CORE_ORIGIN; }

  reentry(key: string, pluginId: string): HookFailure | undefined {
    const state = this.storage.getStore();
    if (state?.origin.plugin !== pluginId && !state?.active.has(key)) return undefined;
    return Object.freeze({ kind: 're-entry', budget: MODS_HOOK_BUDGET.catchMs, cause: state?.rewritten ? 'rewritten' : state?.lent ? 'lent' : undefined });
  }

  catching(key: string): boolean { return this.storage.getStore()?.caught.has(key) ?? false; }

  hook<T>(key: string, scope: HookScope, catching: boolean, work: () => T): T {
    const previous = this.storage.getStore();
    return this.storage.run({ ...previous, origin: this.origin, active: new Set([...(previous?.active ?? []), key]), caught: new Set([...(previous?.caught ?? []), ...(catching ? [key] : [])]), scope }, work);
  }

  core<T>(work: () => T): T {
    return this.storage.run({ origin: CORE_ORIGIN, active: new Set(), caught: new Set() }, work);
  }

  detached<T>(pluginId: string, work: () => T): T {
    return this.storage.run({ origin: Object.freeze({ plugin: pluginId, tier: 'user' }), active: new Set(), caught: new Set(), detached: true }, work);
  }

  provide<T>(pluginId: string, work: () => T): T {
    const previous = this.storage.getStore();
    return this.storage.run({ ...previous, origin: this.origin, active: previous?.active ?? new Set(), caught: previous?.caught ?? new Set(), lent: previous?.lent || this.origin.tier !== 'core' && this.origin.plugin !== pluginId }, work);
  }

  next<T>(rewritten: boolean, work: () => T): T {
    const previous = this.storage.getStore();
    return this.wait(() => this.storage.run({ ...previous, origin: this.origin, active: previous?.active ?? new Set(), caught: previous?.caught ?? new Set(), rewritten: previous?.rewritten || rewritten }, work));
  }

  signal(base: AbortSignal, context?: AbortSignal): AbortSignal {
    const state = this.storage.getStore();
    const scope = state?.scope;
    scope?.assertActive();
    const signal = context === undefined || state?.detached ? base : AbortSignal.any([base, context]);
    return scope === undefined ? signal : AbortSignal.any([signal, scope.signal]);
  }

  api<T extends object>(pluginId: string, api: T): T {
    const wrap = (value: unknown, path: string): unknown => {
      if (typeof value === 'function') return (...args: unknown[]) => {
        const previous = this.storage.getStore();
        previous?.scope?.assertActive();
        const run = () => this.storage.run({ ...previous, origin: Object.freeze({ plugin: pluginId, tier: 'user' }), active: previous?.active ?? new Set(), caught: previous?.caught ?? new Set() }, () => value(...args));
        return path.startsWith('clock.') ? run() : this.wait(run);
      };
      if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, wrap(child, path ? `${path}.${key}` : key)]));
    };
    return wrap(api, '') as T;
  }

  private wait<T>(work: () => T): T {
    const resume = this.storage.getStore()?.scope?.pause();
    try {
      const result = work();
      if (result !== null && typeof result === 'object' && 'then' in result && typeof result.then === 'function') return Promise.resolve(result).finally(resume) as T;
      resume?.();
      return result;
    } catch (error) { resume?.(); throw error; }
  }
}
