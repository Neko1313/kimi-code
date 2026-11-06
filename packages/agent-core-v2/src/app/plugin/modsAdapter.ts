import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { abortable } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';

import type { CatchHandler, Caught, Elements, EngineInterface, HookFailure, ModsEvent, ModsHandler, ModsNext, On, Register, Registration, RenderElement, StateAddress, StateRead } from './mods';
import type { RuntimeContext, RuntimeEventPayload, RuntimeNext, RuntimePluginApi, RuntimeRegistrar } from './runtime';
import { freezeEvent, synchronizePromptContext } from './modsContext';
import { modsToolArgs, nativeToolArgs, nativeToolCall } from './modsTools';
import { HookScope, HookTimeout, MODS_HOOK_BUDGET, type RuntimeExecution } from './runtimeExecution';

interface Frame { render: boolean; snapshot: Map<string, StateRead> }
interface Provider { pluginId: string; handler: ModsHandler }
interface HookEntry { handler: ModsHandler; catcher?: CatchHandler }
interface RegistrationScope { open: boolean }
interface Callback { surface: string; pluginId: string; context: string; paneId: string; siteComponent?: string; key: string; event: string; kind?: string; values?: readonly string[]; run: (value: unknown, event: ModsEvent) => unknown }
interface AdapterHost {
  readonly execution: RuntimeExecution;
  warn(pluginId: string, event: string, error: HookFailure): void;
  interactive(): boolean;
  changed(): void;
  api(pluginId: string, context: RuntimeContext): RuntimePluginApi;
  invoke(name: string, input: ModsEvent, context: RuntimeContext, terminal: (input: ModsEvent) => unknown, owner?: string): Promise<unknown>;
  panes(context: RuntimeContext): readonly { id: string; title: string; pluginId: string }[];
}

export class ModsAdapter {
  private readonly frames = new AsyncLocalStorage<Frame>();
  private readonly states = new Map<string, StateRead>();
  private readonly callbacks = new Map<string, Callback>();
  private readonly providers: Provider[] = [];
  private readonly registrars = new Map<string, RuntimeRegistrar>();
  private owners = new Map<string, string>();
  private nouns: Record<string, Record<string, (...args: unknown[]) => unknown>> = {};
  private readonly instances = new Map<string, Set<Map<string, Promise<HookEntry[]>>>>();
  private sequence = 0;

  constructor(private readonly host: AdapterHost) {}

  root<T>(work: () => T): T { return this.frames.exit(work); }

  reset(): void { this.callbacks.clear(); this.providers.length = 0; this.registrars.clear(); this.nouns = {}; this.owners.clear(); this.instances.clear(); }
  unload(pluginId: string): void {
    this.registrars.delete(pluginId);
    this.instances.delete(pluginId);
    for (let index = this.providers.length - 1; index >= 0; index--) if (this.providers[index]!.pluginId === pluginId) this.providers.splice(index, 1);
    for (const [key, callback] of this.callbacks) if (callback.pluginId === pluginId) this.callbacks.delete(key);
  }
  disposeSession(sessionId: string): void {
    for (const modules of this.instances.values()) for (const instances of modules) instances.delete(sessionId);
    for (const key of this.states.keys()) if (key.startsWith(`${sessionId}\0`)) this.states.delete(key);
    for (const [key, callback] of this.callbacks) if (callback.context.startsWith(`${sessionId}\0`)) this.callbacks.delete(key);
  }
  close(pluginId: string, paneId: string, context: RuntimeContext): void {
    for (const [key, callback] of this.callbacks) if (callback.pluginId === pluginId && callback.paneId === paneId && callback.context.startsWith(`${context.sessionId ?? ''}\0`)) this.callbacks.delete(key);
  }

  async load(pluginId: string, native: RuntimeRegistrar, register: Register, options: Record<string, unknown>): Promise<void> {
    const instances = new Map<string, Promise<HookEntry[]>>();
    let modules = this.instances.get(pluginId);
    if (modules === undefined) { modules = new Set(); this.instances.set(pluginId, modules); }
    modules.add(instances);
    const resolve = async (index: number, hook: HookEntry, context: RuntimeContext): Promise<HookEntry> => {
      if (context.sessionId === undefined) return hook;
      let instance = instances.get(context.sessionId);
      if (instance === undefined) {
        instance = (async () => {
          const hooks: HookEntry[] = [];
          const scope: RegistrationScope = { open: true };
          const collect = ((name: string, matcherOrHandler: Record<string, unknown> | ModsHandler, handler?: ModsHandler) => {
            if (!scope.open) throw new Error('Mod registration has already finished');
            const entry = { handler: handler ?? matcherOrHandler as ModsHandler };
            if (name !== 'engine.create') hooks.push(entry);
            return this.registration(entry, name, scope);
          }) as On;
          try { await register(collect, structuredClone(options)); }
          finally { scope.open = false; }
          return hooks;
        })();
        instances.set(context.sessionId, instance);
      }
      const handler = (await instance)[index];
      if (handler === undefined) throw new Error('Mod registration changed between session instances');
      return handler;
    };
    const scope: RegistrationScope = { open: true };
    try { await register(this.register(pluginId, native, scope, resolve), structuredClone(options)); }
    finally { scope.open = false; }
  }

  private register(pluginId: string, native: RuntimeRegistrar, scope: RegistrationScope, resolve: (index: number, hook: HookEntry, context: RuntimeContext) => Promise<HookEntry>): On {
    this.registrars.set(pluginId, native);
    let index = 0;
    return ((name: string, matcherOrHandler: Record<string, unknown> | ModsHandler, handler?: ModsHandler) => {
      if (!scope.open) throw new Error('Mod registration has already finished');
      const hook = handler ?? matcherOrHandler as ModsHandler;
      const entry: HookEntry = { handler: hook };
      const registration = this.registration(entry, name, scope);
      const matcher = handler === undefined ? undefined : matcherOrHandler as Record<string, unknown>;
      if (name === 'command.run' && typeof matcher?.['command'] === 'string') {
        const command = matcher['command'];
        native.command(command, `Run ${command}`, (api, e) => this.host.invoke('command.run', { command, args: e.data['args'] }, api.context, () => { throw new Error(`Unanswered command: ${command}`); }));
      }
      if (name === 'engine.create') { this.providers.push({ pluginId, handler: hook }); return registration; }
      const position = index++;
      const id = this.sequence++;
      native(name === 'session.start' ? 'SessionStart' : name, async (api, event, next) => {
        const data = event.event === 'tool.call' ? modsToolArgs(event.data['tool'], event.data) : event.event === 'tool.check' && event.data['input'] !== null && typeof event.data['input'] === 'object' ? { ...event.data, input: modsToolArgs(event.data['tool'], event.data['input'] as ModsEvent) } : event.data;
        const { __siteComponent: _siteComponent, ...publicData } = data;
        const flat: ModsEvent = freezeEvent(structuredClone({ ...publicData, ...(name === 'session.start' ? { cwd: event.cwd, isInteractive: this.host.interactive() } : {}) }));
        if (matcher !== undefined && !matches(matcher, flat)) return next(event);
        const resolved = await resolve(position, entry, api.context);
        return this.frame(event.event === 'ui.render', () => this.runHook(pluginId, `${api.context.sessionId ?? ''}\0${api.context.agentId ?? 'main'}\0${id}`, name === 'session.start' ? name : event.event, resolved, flat, api, event, next));
      });
      return registration;
    }) as On;
  }

  private registration(entry: HookEntry, event: string, scope: RegistrationScope): Registration {
    return Object.freeze({ catch: (handler: CatchHandler) => {
      if (!scope.open) throw new Error('Cannot attach .catch after register returned');
      if (event === 'engine.create') throw new Error('engine.create does not support .catch');
      if (entry.catcher !== undefined) throw new Error('A hook accepts only one .catch handler');
      if (typeof handler !== 'function') throw new Error('Invalid .catch handler');
      entry.catcher = handler;
    } });
  }

  private async runHook(pluginId: string, key: string, name: string, entry: HookEntry, flat: ModsEvent, api: RuntimePluginApi, event: RuntimeEventPayload, next: RuntimeNext): Promise<unknown> {
    const execution = this.host.execution;
    if (execution.catching(key)) return next(event);
    const origin = execution.origin;
    const baseSignal = api.signal;
    let latest: Promise<unknown> | undefined;
    let beneath: ModsEvent | undefined;
    let lastError: unknown;
    const callNext = (input: ModsEvent): Promise<unknown> => {
      const value = event.event === 'prompt.context' ? synchronizePromptContext(flat, input) : event.event === 'tool.call' ? nativeToolArgs(input['tool'], input) : input;
      const data = typeof event.data['__siteComponent'] === 'string' ? { ...value, __siteComponent: event.data['__siteComponent'] } : value;
      const rewritten = ['tool.call', 'agent.spawn', 'PreToolUse', 'classic.PreToolUse'].includes(event.event) && JSON.stringify(input) !== JSON.stringify(flat);
      const pending = execution.next(rewritten, () => Promise.resolve().then(() => next({ ...event, data }))).then(result => {
        if (event.event === 'prompt.context') beneath = result as ModsEvent;
        return result;
      });
      latest = pending;
      lastError = undefined;
      void pending.catch(error => { if (latest === pending) lastError = error; });
      return pending;
    };
    const replay = (input: ModsEvent): Promise<unknown> => latest ?? callNext(input);
    const finish = (result: unknown): unknown => {
      if (result === undefined && latest === undefined) throw new Error(`Invalid ${name} hook result: missing return value`);
      if (event.event === 'prompt.context') return synchronizePromptContext(beneath ?? flat, result as ModsEvent);
      if (event.event === 'ui.render' && result !== undefined) return this.wire(result as RenderElement, pluginId, api.context, String(flat['requestId']), typeof flat['surface'] === 'string' ? flat['surface'] : 'terminal', typeof event.data['__siteComponent'] === 'string' ? event.data['__siteComponent'] : undefined);
      if (['tool.call', 'tool.check', 'command.run', 'agent.spawn'].includes(event.event) && (result === null || typeof result !== 'object')) throw new Error(`Invalid ${name} hook result`);
      const answer = result as Record<string, unknown> | undefined;
      if (event.event === 'tool.call' && answer !== undefined && !('result' in answer) && typeof answer['deny'] !== 'string') throw new Error('Invalid tool.call hook result');
      if (event.event === 'tool.check' && !['allow', 'ask', 'deny'].includes(String(answer?.['decision']))) throw new Error('Invalid tool.check hook result');
      if (event.event === 'agent.spawn' && typeof answer?.['agentId'] !== 'string' && typeof answer?.['deny'] !== 'string') throw new Error('Invalid agent.spawn hook result');
      if (event.event === 'tool.describe' && (typeof answer?.['description'] !== 'string' || answer?.['isDeferred'] !== undefined && typeof answer['isDeferred'] !== 'boolean')) throw new Error('Invalid tool.describe hook result');
      if (event.event === 'prompt.section' && answer?.['text'] !== null && typeof answer?.['text'] !== 'string') throw new Error('Invalid prompt.section hook result');
      if (event.event === 'prompt.compose' && (!Array.isArray(answer?.['sections']) || answer['sections'].some(section => section === null || typeof section !== 'object' || typeof section.id !== 'string' || typeof section.text !== 'string' || !['shared','session'].includes(section.scope)))) throw new Error('Invalid prompt.compose hook result');
      return result;
    };
    const run = (handler: ModsHandler | CatchHandler, failure?: HookFailure): Promise<unknown> => {
      const scope = new HookScope(failure === undefined ? MODS_HOOK_BUDGET.ms : MODS_HOOK_BUDGET.catchMs, baseSignal, () => { this.host.warn(pluginId, name, Object.freeze({ kind: 'timeout', message: 'Mod hook is still running after cancellation', budget: MODS_HOOK_BUDGET.lingerMs })); });
      const called = latest !== undefined;
      const delegate = ((input: ModsEvent = flat) => {
        scope.assertActive();
        return failure === undefined ? callNext(input) : execution.next(false, () => replay(input));
      }) as ModsNext & Partial<Caught>;
      Object.defineProperties(delegate, {
        signal: { value: scope.signal }, event: { value: name }, origin: { value: origin },
        budget: { get: () => Object.freeze({ ms: scope.ms, remainingMs: scope.remainingMs }) },
      });
      if (failure !== undefined) Object.defineProperties(delegate, { error: { value: failure }, called: { value: called } });
      delegate.is = pattern => matchName(pattern, name);
      return execution.hook(key, scope, failure !== undefined, () => scope.run(async () => {
        const result = await handler(this.api(pluginId, api.context), flat, delegate as ModsNext & Caught);
        return result === undefined && failure !== undefined ? undefined : finish(result);
      }));
    };
    let failure = execution.reentry(key, pluginId);
    if (failure === undefined) {
      try { return await run(entry.handler); }
      catch (error) {
        baseSignal.throwIfAborted();
        failure = Object.freeze({ kind: error instanceof HookTimeout ? 'timeout' : 'throw', message: error instanceof HookTimeout ? lastError === undefined ? undefined : toErrorMessage(lastError) : toErrorMessage(error), budget: MODS_HOOK_BUDGET.catchMs });
        this.host.warn(pluginId, name, failure);
      }
    }
    if (latest !== undefined) await abortable(latest.catch(() => undefined), baseSignal);
    baseSignal.throwIfAborted();
    if (entry.catcher !== undefined) {
      try {
        const result = await run(entry.catcher, failure);
        if (result !== undefined) return result;
      } catch (error) {
        baseSignal.throwIfAborted();
        this.host.warn(pluginId, name, Object.freeze({ kind: error instanceof HookTimeout ? 'timeout' : 'throw', message: toErrorMessage(error), budget: MODS_HOOK_BUDGET.catchMs }));
      }
    }
    return abortable(replay(flat), baseSignal);
  }

  async build(): Promise<void> {
    const owners = new Map<string, string>();
    const fold = async (index: number): Promise<Record<string, Record<string, (...args: unknown[]) => unknown>>> => {
      const provider = this.providers[index];
      if (provider === undefined) return {};
      let called = false;
      let beneath: Record<string, Record<string, (...args: unknown[]) => unknown>> = {};
      const next = (async () => {
        if (called) throw new Error('engine.create called next more than once');
        called = true;
        beneath = await fold(index + 1);
        return beneath;
      }) as ModsNext;
      next.is = (name) => name === 'engine.create';
      Object.defineProperties(next, { signal: { value: new AbortController().signal }, event: { value: 'engine.create' }, origin: { value: this.host.execution.origin }, budget: { get: () => Object.freeze({ ms: 0, remainingMs: Infinity }) } });
      const result = await provider.handler(new Proxy({} as EngineInterface, { get: () => { throw new Error('$ is unavailable during engine.create'); } }), {}, next) as typeof beneath;
      if (result === null || typeof result !== 'object') throw new Error('engine.create must return a noun table');
      for (const [noun, methods] of Object.entries(result)) {
        if (['ui', 'state', 'store', 'clock', 'command', 'tool', 'agent', 'prompt', 'fs', 'env', 'session', 'plugin', 'kimi'].includes(noun)) throw new Error(`Reserved engine noun: ${noun}`);
        if (beneath[noun] === methods) continue;
        if (beneath[noun] !== undefined) throw new Error(`Duplicate engine noun: ${noun}`);
        if (methods === null || typeof methods !== 'object' || Object.values(methods).some((method) => typeof method !== 'function')) throw new Error(`Invalid engine noun: ${noun}`);
        owners.set(noun, provider.pluginId);
      }
      for (const noun of Object.keys(beneath)) if (!(noun in result)) throw new Error(`engine.create dropped noun: ${noun}`);
      return result;
    };
    this.nouns = await fold(0);
    this.owners = owners;
    for (const [noun, methods] of Object.entries(this.nouns)) {
      const owner = owners.get(noun)!;
      this.registrars.get(owner)!.domain(noun, Object.fromEntries(Object.keys(methods).map((method) => [method, {
        input: {}, handler: (api: RuntimePluginApi, event: RuntimeEventPayload) => this.invoke(`${noun}.${method}`, event.data['input'] as ModsEvent, api.context),
      }])));
    }
  }

  async invoke(name: string, input: ModsEvent, context: RuntimeContext): Promise<unknown> {
    const [noun, method] = name.split('.');
    const bottom = this.nouns[noun!]?.[method!];
    if (bottom === undefined) throw new Error(`Unsupported Mods API: ${name}`);
    const owner = this.owners.get(noun!)!;
    const result = await this.host.execution.provide(owner, () => this.host.invoke(name, input, context, (rewritten) => bottom(rewritten), owner));
    if (result !== null && typeof result === 'object' && 'deny' in result && typeof result.deny === 'string') throw new Error(result.deny);
    return result !== null && typeof result === 'object' && 'value' in result ? result.value : result;
  }

  async interact(pluginId: string, paneId: string, input: { handle: string; value?: unknown }, context: RuntimeContext): Promise<void> {
    const callback = this.callbacks.get(input.handle);
    if (callback === undefined || callback.pluginId !== pluginId || callback.paneId !== paneId || callback.context !== this.contextKey(context)) throw new Error('Stale or foreign UI callback');
    if (callback.values !== undefined && (typeof input.value !== 'string' || !callback.values.includes(input.value))) throw new Error('Invalid Select value');
    if (callback.event === 'ui.input' && (typeof input.value !== 'string' || input.value.length > 100_000)) throw new Error('Invalid Input value');
    const event = { surface: callback.surface, component: callback.siteComponent ?? 'Pane', requestId: paneId, element: callback.key, value: input.value, kind: callback.kind };
    await this.frame(false, () => this.host.invoke(callback.event, event, context, (rewritten) => {
      if (callback.values !== undefined && !callback.values.includes(String(rewritten['value']))) throw new Error('Invalid rewritten Select value');
      return this.host.execution.detached(pluginId, () => callback.run(rewritten['value'], rewritten));
    }));
  }

  async interactSite(component: string, requestId: string, input: { handle: string; value?: unknown }, context: RuntimeContext): Promise<void> {
    const callback = this.callbacks.get(input.handle);
    if (callback === undefined || callback.paneId !== requestId || callback.siteComponent !== component) throw new Error('Stale or foreign UI callback');
    await this.interact(callback.pluginId, callback.paneId, input, context);
  }

  private frame<T>(render: boolean, run: () => Promise<T>): Promise<T> {
    return this.frames.getStore() === undefined ? this.frames.run({ render, snapshot: new Map(this.states) }, run) : run();
  }
  private contextKey(context: RuntimeContext): string { return `${context.sessionId ?? ''}\0${context.agentId ?? 'main'}\0${context.clientId ?? ''}`; }
  private stateKey(ref: StateAddress, context: RuntimeContext): string { return `${context.sessionId ?? ''}\0${ref.plugin}\0${ref.key}\0${ref.id ?? ''}`; }

  private api(pluginId: string, context: RuntimeContext): EngineInterface {
    const native = this.host.api(pluginId, context);
    const base = {
      plugin: { name: pluginId }, kimi: native,
      tool: {
        register: (spec: import('./runtime').RuntimeToolSpec) => native.tool.register(spec),
        list: async () => native.tool.list(), call: (input: import('./runtime').RuntimeToolCall) => native.tool.call(nativeToolCall(input)), check: (input: import('./runtime').RuntimeToolCall) => native.tool.check(nativeToolCall(input)),
      },
      agent: {
        list: async () => native.agent.list(), stop: (input: { id: string }) => native.agent.stop(input.id), run: (input: import('./runtime').RuntimeAgentOptions) => native.agent.run(input),
        spawn: (input: { prompt: string; model: string; description?: string; subagentType?: string; schema?: Record<string, unknown> }): Promise<{ id: string; agentId: string; model: string }> => new Promise((resolve, reject) => {
          void native.agent.run({ prompt: input.prompt, model: input.model, label: input.description, profile: input.subagentType, schema: input.schema, onStarted: (id, _taskId, model) => { resolve({ id, agentId: id, model }); } }).catch(reject);
        }),
      },
      prompt: { compose: () => native.prompt.compose(), context: (input: import('./runtime').RuntimePromptContext) => native.prompt.context(input) },
      fs: { ancestors: (input: import('./runtime').RuntimeFsAncestorsRequest) => native.fs.ancestors(input) },
      session: { ...native.session },
      env: { get: (name: string) => native.env.get(name) },
      store: { get: <T>(key: string) => native.store.get<T>(key), set: (key: string, value: unknown) => native.store.set(key, value), delete: (key: string) => native.store.delete(key), keys: () => native.store.keys() },
      clock: { ...native.clock, now: async () => Date.now() },
      command: { register: async (spec: { name: string; description: string }) => {
        this.registrars.get(pluginId)!.command(spec.name, spec.description, (api, e) => this.host.invoke('command.run', { command: spec.name, args: e.data['args'], origin: { kind: 'composer' } }, api.context, () => { throw new Error(`Unanswered command: ${spec.name}`); }));
        return { command: spec.name };
      } },
      state: {
        get: async (ref: StateAddress) => {
          native.state.get('mods-capability-check');
          return structuredClone((this.frames.getStore()?.snapshot ?? this.states).get(this.stateKey(ref, context)) ?? { value: undefined, version: 0 });
        },
        set: async (ref: StateAddress, value: unknown, options?: { ifVersion?: number }) => {
          native.state.get('mods-capability-check');
          if (ref.plugin !== pluginId) throw new Error('Only the state owner may write it');
          if (this.frames.getStore()?.render) throw new Error('State writes during ui.render are refused');
          if (value === undefined) throw new Error('State value must be JSON data');
          const key = this.stateKey(ref, context);
          const previous = this.states.get(key) ?? { value: undefined, version: 0 };
          if (options?.ifVersion !== undefined && options.ifVersion !== previous.version) {
            const frame = this.frames.getStore();
            if (frame !== undefined) frame.snapshot = new Map(this.states);
            return { isSet: false, version: previous.version };
          }
          const version = previous.version + 1;
          this.states.set(key, { value: json(value), version });
          this.host.changed();
          return { isSet: true, version };
        },
      },
      ui: {
        resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Select', 'Input', 'Markdown', 'Code', 'Link', 'Svg'].map((type) => [type, (props: Record<string, unknown>) => {
          const { children, ...rest } = props;
          return { type, props: rest, children: children === undefined ? undefined : Array.isArray(children) ? children : [children] };
        }])) as unknown as Elements,
        open: async (options: { id: string; title?: string; columns?: number; rows?: number; focus?: boolean; closeOnEscape?: boolean }) => {
          if (context.sessionId === undefined || !this.host.interactive()) return { isPlaced: false, reason: 'No interactive session' };
          await native.ui.open({ ...options, title: options.title ?? options.id });
          return { isPlaced: true };
        },
        close: async (options: { id: string }) => { await native.ui.close(options); this.close(pluginId, options.id, context); },
        panes: async () => this.host.panes(context).filter((pane) => pane.pluginId === pluginId),
        invalidate: (event?: 'ui.render' | 'prompt.context') => { native.ui.invalidate(event); }, log: (text: string, options?: { to?: 'debug' | 'transcript' }) => { if (options?.to !== undefined && options.to !== 'debug') throw new Error('Unsupported Mods API: ui.log transcript target'); native.log.info(text); },
        view: (input: { agentId?: string }) => native.ui.view(input),
        status: (text?: string) => native.ui.status(text),
        toast: (text: string, options?: { timeoutMs?: number }) => native.ui.toast(text, options),
      },
    };
    const op = async <T>(name: string, input: ModsEvent, bottom: (e: ModsEvent) => unknown, value = false): Promise<T> => {
      const result = await this.host.invoke(name, input, context, async (rewritten) => {
        const result = await bottom(rewritten);
        return value ? { value: result } : result;
      });
      return (value && result !== null && typeof result === 'object' && 'value' in result ? result.value : result) as T;
    };
    const original = { store: { ...base.store }, state: { ...base.state }, ui: { ...base.ui }, command: { ...base.command } };
    base.store.get = key => op('store.get', { key }, e => original.store.get(String(e['key'])), true);
    base.store.set = (key, value) => op('store.set', { key, value }, e => original.store.set(String(e['key']), e['value']));
    base.store.delete = key => op('store.delete', { key }, e => original.store.delete(String(e['key'])));
    base.store.keys = () => op('store.keys', {}, () => original.store.keys(), true);
    base.state.get = ref => op('state.get', { ...ref }, e => original.state.get(e as unknown as StateAddress));
    base.state.set = (ref, value, options) => op('state.set', { ...ref, value, ifVersion: options?.ifVersion }, e => original.state.set(e as unknown as StateAddress, e['value'], { ifVersion: e['ifVersion'] as number | undefined }));
    base.ui.open = options => op('ui.open', options, e => original.ui.open(e as unknown as Parameters<typeof original.ui.open>[0]));
    base.ui.close = options => op('ui.close', options, e => original.ui.close(e as unknown as { id: string }));
    base.ui.panes = () => op('ui.panes', {}, () => original.ui.panes(), true);
    base.clock.now = () => op('clock.now', {}, () => Date.now(), true);
    base.command.register = spec => op('command.register', spec, e => original.command.register(e as unknown as Parameters<typeof original.command.register>[0]));
    const registerTool = base.tool.register;
    base.tool.register = spec => op('tool.register', { ...spec }, e => registerTool(e as unknown as Parameters<typeof registerTool>[0]));
    const listTools = base.tool.list;
    base.tool.list = () => op('tool.list', {}, listTools, true);
    const listAgents = base.agent.list;
    base.agent.list = () => op('agent.list', {}, listAgents, true);
    const ancestors = base.fs.ancestors;
    base.fs.ancestors = input => op('fs.ancestors', { ...input }, e => ancestors(e as unknown as Parameters<typeof ancestors>[0]), true);
    const sessionRoot = base.session.root.bind(base.session);
    const sessionCwd = base.session.cwd.bind(base.session);
    base.session.root = () => op('session.root', {}, sessionRoot, true);
    base.session.cwd = () => op('session.cwd', {}, sessionCwd, true);
    base.session.id = () => op('session.id', {}, () => native.session.id(), true);
    base.session.model = () => op('session.model', {}, () => native.session.model(), true);
    base.session.usage = () => op('session.usage', {}, () => native.session.usage(), true);
    base.session.surfaces = () => op('session.surfaces', {}, () => native.session.surfaces(), true);
    base.session.version = () => op('session.version', {}, () => native.session.version(), true);
    base.ui.status = text => op('ui.status', { text }, e => native.ui.status(e['text'] as string | undefined));
    base.ui.toast = (text, options) => op('ui.toast', { text, ...options }, e => native.ui.toast(String(e['text']), { timeoutMs: e['timeoutMs'] as number | undefined }));
    const envGet = base.env.get;
    base.env.get = name => op('env.get', { name }, e => envGet(String(e['name'])), true);
    const supported = this.host.execution.api(pluginId, base);
    for (const noun of ['ui', 'store', 'state', 'clock', 'command', 'tool', 'agent', 'prompt', 'fs', 'env', 'session'] as const) {
      Object.assign(supported, { [noun]: new Proxy(supported[noun], { get: (target, property: string) => {
        if (property === 'then') return undefined;
        if (!(property in target)) throw new Error(`Unsupported Mods API: ${noun}.${property}`);
        return Reflect.get(target, property);
      } }) });
    }
    return new Proxy(supported as unknown as EngineInterface, { get: (target, noun: string) => {
      if (noun in target) return target[noun as keyof EngineInterface];
      if (noun === 'then') return undefined;
      if (this.nouns[noun] === undefined) throw new Error(`Unsupported Mods API noun: ${noun}`);
      return this.host.execution.api(pluginId, Object.fromEntries(Object.keys(this.nouns[noun]!).map((method) => [method, (input: ModsEvent) => this.invoke(`${noun}.${method}`, input, context)])));
    } });
  }

  private wire(tree: RenderElement, pluginId: string, context: RuntimeContext, paneId: string, surface: string, siteComponent?: string): RenderElement {
    const pending = new Map<string, Callback>();
    const keys = new Set<string>();
    let nodes = 0;
    const visit = (node: RenderElement | string, depth: number): RenderElement | string => {
      if (++nodes > 10000 || depth > 64) throw new Error('Mods tree exceeds limits');
      if (typeof node === 'string') return node;
      if (!node || !['Box', 'Text', 'Button', 'Select', 'Input', 'Markdown', 'Code', 'Link', 'Svg'].includes(node.type)) throw new Error('Unsupported Mods element');
      const props = { ...node.props };
      if (node.type === 'Svg') {
        if (typeof props['source'] !== 'string' || props['source'].length > 1_000_000 || typeof props['alt'] !== 'string' || props['alt'].length > 4000 || (node.children?.length ?? 0) > 0) throw new Error('Invalid SVG source');
        for (const size of ['width', 'height']) if (props[size] !== undefined && (typeof props[size] !== 'number' || !Number.isFinite(props[size]) || props[size] <= 0 || props[size] > 10000)) throw new Error('Invalid SVG size');
      }
      if (['Button', 'Select', 'Input'].includes(node.type)) {
        if (typeof props['key'] !== 'string' || keys.has(props['key'])) throw new Error('Interactive elements need unique string keys');
        keys.add(props['key']);
      }
      for (const [property, event] of [['onPress', 'ui.press'], ['onSelect', 'ui.select'], ['onInput', 'ui.input'], ['onSubmit', 'ui.input']] as const) {
        const run = props[property];
        if (run === undefined) continue;
        if (typeof run !== 'function' || typeof props['key'] !== 'string') throw new Error('Invalid element callback');
        const kind = property === 'onSubmit' ? 'submit' : property === 'onInput' ? 'change' : undefined;
        const handle = [...this.callbacks].find(([, current]) => current.pluginId === pluginId && current.context === this.contextKey(context) && current.paneId === paneId && current.siteComponent === siteComponent && current.key === props['key'] && current.event === event && current.kind === kind)?.[0] ?? randomUUID();
        pending.set(handle, { surface, pluginId, context: this.contextKey(context), paneId, siteComponent, key: props['key'], event, kind,
          values: node.type === 'Select' ? (props['options'] as { value: string }[]).map((option) => option.value) : undefined,
          run: (value, e) => property === 'onPress' ? run(e) : run(value, e),
        });
        delete props[property];
        props[kind === 'submit' ? 'submitCallback' : 'callback'] = handle;
      }
      for (const property of ['callback', 'submitCallback']) {
        const handle = props[property];
        const callback = typeof handle === 'string' ? this.callbacks.get(handle) : undefined;
        if (typeof handle === 'string' && !pending.has(handle) && callback?.pluginId === pluginId && callback.context === this.contextKey(context) && callback.paneId === paneId && callback.siteComponent === siteComponent) pending.set(handle, callback);
      }
      return { type: node.type, props: json(props) as Record<string, unknown>, children: node.children?.map((child) => visit(child, depth + 1)) };
    };
    const result = visit(tree, 0) as RenderElement;
    if (JSON.stringify(result).length > 4_000_000) throw new Error('Mods tree exceeds limit');
    for (const [id, callback] of this.callbacks) if (callback.pluginId === pluginId && callback.context === this.contextKey(context) && callback.paneId === paneId && callback.siteComponent === siteComponent) this.callbacks.delete(id);
    for (const [id, callback] of pending) this.callbacks.set(id, callback);
    return result;
  }
}

function json(value: unknown): unknown {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'function' || typeof item === 'bigint') throw new Error('Expected JSON data');
    return item;
  });
  if (encoded === undefined || encoded.length > 4_000_000) throw new Error('JSON value exceeds limit');
  return JSON.parse(encoded);
}
function matches(pattern: Record<string, unknown>, value: ModsEvent): boolean {
  return Object.entries(pattern).every(([key, expected]) => {
    const actual = value[key];
    if (Array.isArray(actual) && expected !== null && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof RegExp)) return actual.some(item => item !== null && typeof item === 'object' && matches(expected as Record<string, unknown>, item));
    if (expected instanceof RegExp) { expected.lastIndex = 0; return typeof actual === 'string' && expected.test(actual); }
    if (Array.isArray(expected)) return expected.some((item) => matches({ value: item }, { value: actual }));
    if (expected !== null && typeof expected === 'object') return actual !== null && typeof actual === 'object' && matches(expected as ModsEvent, actual as ModsEvent);
    return expected === actual;
  });
}
export function matchName(pattern: string, name: string): boolean {
  return new RegExp(`^${pattern.split('*').map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);
}
