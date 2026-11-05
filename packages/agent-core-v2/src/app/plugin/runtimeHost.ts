import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IFlagService } from '#/app/flag/flag';
import { IPluginService } from '#/app/plugin/plugin';
import type { HookResult } from '#/features/externalHooks/internal/types';

import {
  IPluginRuntimeHost,
  registerPluginUiHost,
  type PluginPaneInfo,
  type PluginRuntimeConfig,
  type RuntimeDispatchArgs,
  type RuntimeElement,
  type RuntimeEventPayload,
  type RuntimeHandler,
  type RuntimeModule,
  type RuntimeNext,
  type RuntimePluginApi,
} from './runtime';
import { PLUGIN_RUNTIME_FLAG_ID } from './runtimeFlag';

const HANDLER_TIMEOUT_MS = 30_000;
const RUNTIME_DIR_NAME = 'plugin-runtime';

interface LoadedHandler {
  readonly pluginId: string;
  readonly matcher: RegExp | undefined;
  readonly handler: RuntimeHandler;
}

interface LoadedModule {
  readonly timers: { cancel(): void }[];
  dispose(): void;
}

export class PluginRuntimeHost extends Disposable implements IPluginRuntimeHost {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  private byEvent = new Map<string, LoadedHandler[]>();
  private modules: LoadedModule[] = [];
  private storeDirs = new Map<string, string>();
  private storeQueues = new Map<string, Promise<void>>();
  private panes = new Map<string, { pluginId: string; title: string }>();
  private uiListeners = new Set<() => void>();

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.ready = this.loadSafe();
    this._register(this.plugins.onDidReload(() => void this.reload()));
    registerPluginUiHost({
      listPanes: () =>
        [...this.panes.entries()].map(([id, pane]) => ({ id, title: pane.title })),
      renderPane: (id, width) => this.renderPane(id, width),
      dispatchKey: (id, key) => this.dispatchKey(id, key),
      onDidChange: (listener) => {
        this.uiListeners.add(listener);
        return () => this.uiListeners.delete(listener);
      },
    });
  }

  listPanes(): readonly PluginPaneInfo[] {
    return [...this.panes.entries()].map(([id, pane]) => ({ id, title: pane.title }));
  }

  async renderPane(id: string, width: number): Promise<RuntimeElement | undefined> {
    await this.ready;
    const pane = this.panes.get(id);
    if (pane === undefined) return undefined;
    const handlers = (this.byEvent.get('ui.render') ?? []).filter(
      (handler) => handler.pluginId === pane.pluginId,
    );
    const payload: RuntimeEventPayload = {
      event: 'ui.render',
      cwd: process.cwd(),
      data: { component: 'Pane', requestId: id, width },
    };
    for (const handler of handlers) {
      let nextCalled = false;
      const next: RuntimeNext = async (rewritten) => {
        nextCalled = true;
        return rewritten ?? payload;
      };
      try {
        const outcome = await this.withTimeout(
          Promise.resolve(handler.handler(this.apiFor(handler.pluginId), payload, next)),
        );
        if (!nextCalled && isRuntimeElement(outcome)) return outcome;
      } catch (error) {
        this.log.warn(`ui.render handler failed for pane ${id}`, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return undefined;
  }

  async dispatchKey(id: string, key: string): Promise<void> {
    await this.ready;
    const pane = this.panes.get(id);
    if (pane === undefined) return;
    const handlers = (this.byEvent.get('ui.key') ?? []).filter(
      (handler) => handler.pluginId === pane.pluginId,
    );
    const payload: RuntimeEventPayload = {
      event: 'ui.key',
      cwd: process.cwd(),
      data: { paneId: id, key },
    };
    for (const handler of handlers) {
      try {
        await this.withTimeout(
          Promise.resolve(handler.handler(this.apiFor(handler.pluginId), payload, async () => payload)),
        );
      } catch (error) {
        this.log.warn(`ui.key handler failed for pane ${id}`, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private notifyUiChanged(): void {
    for (const listener of this.uiListeners) {
      try {
        listener();
      } catch {}
    }
  }

  private openPane(pluginId: string, id: string, title: string): void {
    this.panes.set(id, { pluginId, title });
    this.log.info(`[${pluginId}] pane opened: ${id}`);
    this.notifyUiChanged();
  }

  private closePane(id: string): void {
    if (this.panes.delete(id)) {
      this.notifyUiChanged();
    }
  }

  hasHandlers(event: string): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0;
  }

  summary(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [event, handlers] of this.byEvent.entries()) {
      result[event] = handlers.length;
    }
    return result;
  }

  async dispatch(event: string, args: RuntimeDispatchArgs): Promise<HookResult[]> {
    await this.ready;
    const handlers = this.match(event, args.matcherValue);
    if (handlers.length === 0) return [];
    const payload: RuntimeEventPayload = {
      event,
      sessionId: args.sessionId,
      cwd: args.cwd,
      data: args.data ?? {},
    };
    const results: HookResult[] = [];
    await this.runChain(handlers, 0, payload, results);
    return results;
  }

  private match(event: string, matcherValue: string | undefined): LoadedHandler[] {
    const all = this.byEvent.get(event) ?? [];
    if (matcherValue === undefined) {
      return all.filter((h) => h.matcher === undefined);
    }
    return all.filter(
      (h) => h.matcher === undefined || h.matcher.test(matcherValue),
    );
  }

  private async runChain(
    handlers: readonly LoadedHandler[],
    index: number,
    event: RuntimeEventPayload,
    results: HookResult[],
  ): Promise<RuntimeEventPayload | undefined> {
    const current = handlers[index];
    if (current === undefined) return event;
    const api = this.apiFor(current.pluginId);
    let nextCalled = false;
    const next: RuntimeNext = async (rewritten) => {
      nextCalled = true;
      const forwarded = rewritten ?? event;
      return this.runChain(handlers, index + 1, forwarded, results);
    };
    try {
      const outcome = await this.withTimeout(
        Promise.resolve(current.handler(api, event, next)),
      );
      if (outcome !== undefined && outcome !== null && typeof outcome === 'object') {
        const block = (outcome as { block?: unknown }).block;
        if (typeof block === 'string') {
          results.push({ action: 'block', reason: block });
        }
      }
      if (nextCalled) return undefined;
      return event;
    } catch (error) {
      this.log.warn(`runtime handler failed for event ${event.event}`, {
        pluginId: current.pluginId,
        message: error instanceof Error ? error.message : String(error),
      });
      return event;
    }
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('runtime handler timed out'));
        }, HANDLER_TIMEOUT_MS);
      }),
    ]);
  }

  private apiFor(pluginId: string): RuntimePluginApi {
    return {
      pluginId,
      log: {
        info: (message) => {
          this.log.info(`[${pluginId}] ${message}`);
        },
        warn: (message) => {
          this.log.warn(`[${pluginId}] ${message}`);
        },
      },
      store: {
        get: (key) => this.storeGet(pluginId, key),
        set: (key, value) => this.storeSet(pluginId, key, value),
        delete: (key) => this.storeDelete(pluginId, key),
      },
      clock: {
        every: (ms, fn) => this.addTimer(pluginId, ms, fn, true),
        after: (ms, fn) => this.addTimer(pluginId, ms, fn, false),
      },
      process: {
        run: (args, options) => this.runProcess(args, options),
      },
      ui: {
        open: async (options) => {
          this.openPane(pluginId, options.id, options.title);
        },
        close: async (options) => {
          this.closePane(options.id);
        },
        invalidate: () => {
          this.notifyUiChanged();
        },
      },
    };
  }

  private runProcess(
    args: readonly string[],
    options: { timeoutMs?: number; cwd?: string; input?: string } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const [command, ...rest] = args;
      if (command === undefined || command.length === 0) {
        reject(new Error('process.run requires a command'));
        return;
      }
      const child = spawn(command, rest, {
        cwd: options.cwd,
        shell: false,
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`process.run timed out: ${command}`));
      }, options.timeoutMs ?? 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
      if (options.input !== undefined) {
        child.stdin.on('error', () => {});
        child.stdin.write(options.input);
      }
      child.stdin.end();
    });
  }

  private addTimer(pluginId: string, ms: number, fn: () => void, repeat: boolean) {
    const wrapped = () => {
      try {
        fn();
      } catch (error) {
        this.log.warn(`[${pluginId}] timer callback failed`, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const timer = repeat
      ? setInterval(wrapped, ms)
      : setTimeout(wrapped, ms);
    const handle = {
      cancel: () => {
        if (repeat) clearInterval(timer);
        else clearTimeout(timer);
      },
    };
    const loaded = this.modules.at(-1);
    if (loaded) loaded.timers.push(handle);
    return handle;
  }

  private storeRoot(): string {
    const base = process.env['KIMI_CODE_HOME'] ?? path.join(homedir(), '.kimi-code');
    return path.join(base, RUNTIME_DIR_NAME);
  }

  private async storeGet<T>(pluginId: string, key: string): Promise<T | undefined> {
    const data = await this.storeRead(pluginId);
    return data[key] as T | undefined;
  }

  private async storeSet(pluginId: string, key: string, value: unknown): Promise<void> {
    await this.storeEnqueue(pluginId, async () => {
      const data = await this.storeRead(pluginId);
      data[key] = value;
      await this.storeWrite(pluginId, data);
    });
  }

  private async storeDelete(pluginId: string, key: string): Promise<void> {
    await this.storeEnqueue(pluginId, async () => {
      const data = await this.storeRead(pluginId);
      delete data[key];
      await this.storeWrite(pluginId, data);
    });
  }

  private storeEnqueue(pluginId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.storeQueues.get(pluginId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.storeQueues.set(pluginId, next);
    return next;
  }

  private async storeRead(pluginId: string): Promise<Record<string, unknown>> {
    const file = this.storeFile(pluginId);
    try {
      const raw = await readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
    return {};
  }

  private async storeWrite(pluginId: string, data: Record<string, unknown>): Promise<void> {
    const file = this.storeFile(pluginId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  }

  private storeFile(pluginId: string): string {
    const cached = this.storeDirs.get(pluginId);
    if (cached !== undefined) return cached;
    const safe = pluginId.replaceAll(/[^A-Za-z0-9_.-]/g, '_');
    const file = path.join(this.storeRoot(), `${safe}.json`);
    this.storeDirs.set(pluginId, file);
    return file;
  }

  private async loadSafe(): Promise<void> {
    try {
      await this.load();
    } catch {}
  }

  private async reload(): Promise<void> {
    for (const loaded of this.modules) {
      loaded.dispose();
    }
    this.modules = [];
    this.byEvent = new Map();
    this.panes = new Map();
    this.notifyUiChanged();
    try {
      await this.load();
    } catch {}
  }

  private async load(): Promise<void> {
    if (!this.flags.enabled(PLUGIN_RUNTIME_FLAG_ID)) return;
    const summaries = await this.plugins.listPlugins();
    const ids = summaries
      .filter((plugin) => plugin.enabled && plugin.state === 'ok')
      .map((plugin) => plugin.id);
    for (const id of ids) {
      try {
        await this.loadPlugin(id);
      } catch (error) {
        this.log.warn(`failed to load runtime for plugin ${id}`, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async loadPlugin(id: string): Promise<void> {
    const info = await this.plugins.getPluginInfo({ id });
    const runtime = info.manifest?.runtime;
    if (runtime === undefined) return;
    this.validateRuntime(id, runtime);
    const loaded: LoadedModule = { timers: [], dispose() {} };
    this.modules.push(loaded);
    for (const modulePath of runtime.modules) {
      const absolute = path.resolve(info.root, modulePath);
      const url = `${pathToFileURL(absolute).href}?t=${Date.now()}`;
      const imported = (await import(url)) as Partial<RuntimeModule>;
      if (typeof imported.register !== 'function') {
        this.log.warn(`runtime module ${modulePath} in plugin ${id} has no register export`);
        continue;
      }
      const register = (event: string, matcherOrHandler: string | RuntimeHandler, handler?: RuntimeHandler) => {
        const actualHandler = handler ?? (matcherOrHandler as RuntimeHandler);
        const matcherText = handler === undefined ? undefined : (matcherOrHandler as string);
        this.addHandler(id, event, matcherText, actualHandler);
      };
      await imported.register(register);
    }
  }

  private addHandler(pluginId: string, event: string, matcherText: string | undefined, handler: RuntimeHandler): void {
    let matcher: RegExp | undefined;
    try {
      matcher = matcherText === undefined ? undefined : new RegExp(matcherText);
    } catch {
      this.log.warn(`invalid matcher for runtime handler in plugin ${pluginId}: ${matcherText}`);
      return;
    }
    const entry: LoadedHandler = { pluginId, matcher, handler };
    const entries = this.byEvent.get(event) ?? [];
    entries.push(entry);
    this.byEvent.set(event, entries);
  }

  private validateRuntime(id: string, runtime: PluginRuntimeConfig): void {
    for (const modulePath of runtime.modules) {
      if (!modulePath.startsWith('./')) {
        this.log.warn(`runtime module path in plugin ${id} must start with ./: ${modulePath}`);
      }
    }
  }
}

function isRuntimeElement(value: unknown): value is RuntimeElement {
  if (value === null || typeof value !== 'object') return false;
  const type = (value as Record<string, unknown>)['type'];
  return type === 'box' || type === 'text' || type === 'button';
}
