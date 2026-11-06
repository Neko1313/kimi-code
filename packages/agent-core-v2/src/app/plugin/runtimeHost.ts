import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Ajv, { type ValidateFunction } from 'ajv';

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { IPluginService } from '#/app/plugin/plugin';
import { IConfigService } from '#/app/config/config';
import type { HookResult } from '#/features/externalHooks/internal/types';

import {
  IPluginRuntimeHost,
  type PluginPaneInfo,
  type RuntimeCapability,
  type RuntimeCommand,
  type RuntimeContext,
  type RuntimeContextAdapter,
  type RuntimeSiteRequest,
  type RuntimeRenderSurface,
  type RuntimeDispatchArgs,
  type RuntimeElement,
  type RuntimeEventPayload,
  type RuntimeHandler,
  type RuntimeMethod,
  type RuntimeModule,
  type RuntimePluginApi,
  type RuntimeRegistrar,
  type RuntimePublishedTool,
  type RuntimeToolSpec,
  type RuntimeView,
} from './runtime';
import { PLUGIN_RUNTIME_FLAG_ID } from './runtimeFlag';
import { RuntimeStore } from './runtimeStore';
import { ModsAdapter, matchName } from './modsAdapter';
import type { ModsEvent } from './mods';
import { PLUGIN_RUNTIME_SETTINGS, type PluginRuntimeSettings } from './runtimeConfig';
import { synchronizePromptContext } from './modsContext';
import { RuntimeExecution } from './runtimeExecution';

const HANDLER_TIMEOUT_MS = 30_000;
const MAX_PROCESS_OUTPUT = 4_000_000;

interface LoadedHandler {
  readonly order: number;
  readonly pluginId: string;
  readonly matcher?: RegExp;
  readonly handler: RuntimeHandler;
}

interface LoadedPlugin {
  readonly api?: 'native' | 'claude-mods';
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly controller: AbortController;
  readonly timers: Set<{ cancel(): void }>;
  readonly store: RuntimeStore;
  readonly tools: readonly RuntimePublishedTool[];
}

interface DomainMethod {
  readonly pluginId: string;
  readonly handler: RuntimeHandler;
  readonly input: ValidateFunction;
  readonly output?: ValidateFunction;
}

export class PluginRuntimeHost extends Disposable implements IPluginRuntimeHost {
  private readonly chrome = new Map<string, { pluginId: string; sessionId?: string; status?: string; toast?: string; toastToken?: object }>();
  declare readonly _serviceBrand: undefined;
  generation = 0;
  get ready(): Promise<void> { return this.initializing.getStore() ? Promise.resolve() : this.reloadQueue; }
  private readonly execution = new RuntimeExecution();
  private readonly mods = new ModsAdapter({
    execution: this.execution,
    warn: (pluginId, event, error) => { this.log.warn(`[${pluginId}] Mod hook failed: ${event}`, { error }); },
    changed: () => { this.change.fire(); },
    interactive: () => !this.bootstrap.args.nonInteractive,
    api: (id, context) => this.apiFor(id, context),
    panes: (context) => this.listPanes(context),
    invoke: (name, input, context, terminal, owner) => this.chain(this.match(name).toSorted((a, b) => Number(a.pluginId === owner) - Number(b.pluginId === owner)), 0, { ...context, event: name, data: input }, event => terminal(event.data)),
  });
  private readonly change = this._register(new Emitter<void>());
  readonly onDidChange = this.change.event;
  private handlerOrder = 0;
  private byEvent = new Map<string, LoadedHandler[]>();
  private loaded = new Map<string, LoadedPlugin>();
  private panes = new Map<string, PluginPaneInfo & { sessionId?: string; component?: string; props?: Record<string, unknown> }>();
  private commands = new Map<string, RuntimeCommand & { handler: RuntimeHandler }>();
  private methods = new Map<string, DomainMethod>();
  private states = new Map<string, Map<string, unknown>>();
  private contexts = new Map<string, RuntimeContextAdapter>();
  private readonly renderClients = new Map<string, { sessionId?: string; surface: RuntimeRenderSurface; seen: number }>();
  private jobs = new Map<string, { controller: AbortController; completion: Promise<unknown> }>();
  private readonly dynamicTools = new Map<string, { context: string; definition: RuntimePublishedTool; validate: ValidateFunction }>();
  private readonly views = new Map<string, RuntimeView>();
  private readonly interaction = new AsyncLocalStorage<boolean>();
  private readonly initializing = new AsyncLocalStorage<boolean>();
  private readonly hookFrames = new AsyncLocalStorage<ReadonlySet<string>>();
  private reloadQueue: Promise<void> = Promise.resolve();
  private readonly validator = new Ajv({ strict: false, allErrors: true });

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config?: IConfigService,
  ) {
    super();
    this.reloadQueue = this.load().catch((error: unknown) => { this.log.warn('Plugin runtime initialization failed', { error }); });
    this._register(this.plugins.onDidReload(() => {
      this.reloadQueue = this.reloadQueue.then(() => this.reload(), () => this.reload());
      void this.reloadQueue.catch((error: unknown) => this.log.warn('Plugin runtime reload failed', { error }));
    }));
    if (config !== undefined) this._register(config.onDidSectionChange(change => {
      if (change.domain !== PLUGIN_RUNTIME_SETTINGS) return;
      this.reloadQueue = this.reloadQueue.then(() => this.reload(), () => this.reload());
      void this.reloadQueue.catch((error: unknown) => { this.log.warn('Plugin option reload failed', { error }); });
    }));
  }

  override dispose(): void {
    this.unload();
    this.states.clear();
    this.contexts.clear();
    this.renderClients.clear();
    super.dispose();
  }

  runCore<T>(work: () => T): T { return this.execution.core(() => this.mods.root(work)); }

  inheritContext(parent: RuntimeContext, agentId: string): void {
    const source = this.contexts.get(this.contextKey(parent));
    const child = this.contexts.get(this.contextKey({ ...parent, agentId }));
    child?.inheritPromptContext?.(source?.readPromptContext?.());
  }

  bindContext(adapter: RuntimeContextAdapter): { dispose(): void } {
    const key = this.contextKey(adapter.context);
    this.contexts.set(key, adapter);
    return { dispose: () => {
      if (this.contexts.get(key) !== adapter) return;
      this.contexts.delete(key);
      for (const client of this.renderClients.keys()) if (client.startsWith(key + '\0')) this.renderClients.delete(client);
      for (const chromeKey of this.chrome.keys()) if (chromeKey.endsWith(`\0${key}`)) this.chrome.delete(chromeKey);
      for (const id of this.views.keys()) if (id.startsWith(key + '\0')) this.views.delete(id);
      if (adapter.context.agentId === 'main') for (const [id, tool] of this.dynamicTools) if (tool.context === adapter.context.sessionId) this.dynamicTools.delete(id);
      for (const stateKey of this.states.keys()) if (stateKey.includes(`\0${key}\0`)) this.states.delete(stateKey);
      if (adapter.context.agentId === 'main') {
        this.mods.disposeSession(adapter.context.sessionId ?? '');
        for (const [id, pane] of this.panes) if (pane.sessionId === adapter.context.sessionId) this.panes.delete(id);
      }
      this.change.fire();
    } };
  }

  listPanes(context?: RuntimeContext): readonly PluginPaneInfo[] {
    return [...this.panes.values()]
      .filter((pane) => pane.sessionId === undefined || pane.sessionId === context?.sessionId)
      .map(({ id, title, pluginId, columns, rows }) => ({ id, title, pluginId, columns, rows }));
  }

  listTools(): readonly RuntimePublishedTool[] {
    return [...this.loaded.values()].flatMap(plugin => plugin.tools);
  }

  toolsFor(context: RuntimeContext): readonly RuntimePublishedTool[] {
    return [...this.listTools(), ...[...this.dynamicTools.values()].filter(item => item.context === context.sessionId).map(item => item.definition)];
  }

  invoke(event: string, input: Record<string, unknown>, context: RuntimeContext, terminal: (input: Record<string, unknown>) => unknown): Promise<unknown> {
    return this.chain(this.match(event), 0, { ...context, event, data: input }, e => terminal(e.data));
  }

  getView(context: RuntimeContext): RuntimeView { return this.views.get(`${this.contextKey(context)}\0${context.clientId ?? ''}`) ?? { revision: 0 }; }

  async listCommands(): Promise<readonly RuntimeCommand[]> {
    await this.ready;
    return [...this.commands.values()].map(({ name, description, pluginId }) => ({ name, description, pluginId }));
  }

  async runCommand(name: string, args: string, context: RuntimeContext): Promise<unknown> {
    await this.ready;
    const command = this.commands.get(name);
    if (command === undefined) throw new Error(`Unknown plugin command: ${name}`);
    return this.runCore(() => this.interaction.run(true, () => {
      const result = Promise.resolve(command.handler(this.apiFor(command.pluginId, context), {
        ...context, event: 'command.run', data: { name, args },
      }, () => undefined));
      return this.loaded.get(command.pluginId)?.api === 'claude-mods' ? result : this.withTimeout(result);
    }));
  }

  async call(name: string, input: unknown, context: RuntimeContext): Promise<unknown> {
    await this.ready;
    const dynamic = this.dynamicTools.get(`${context.sessionId}\0${name}`);
    if (dynamic !== undefined) {
      if (!dynamic.validate(input)) throw new Error(`Invalid input for ${name}: ${this.validator.errorsText(dynamic.validate.errors)}`);
      const result = await this.invoke('tool.call', { ...(input as Record<string, unknown>), tool: dynamic.definition.name, tool_use_id: context.toolCallId }, context, () => { throw new Error(`Unanswered plugin tool: ${dynamic.definition.name}`); });
      if (result !== null && typeof result === 'object' && 'deny' in result) throw new Error(String(result.deny));
      return result;
    }
    const method = this.methods.get(name);
    if (method === undefined) throw new Error(`Unknown plugin method: ${name}`);
    if (!method.input(input)) throw new Error(`Invalid input for ${name}: ${this.validator.errorsText(method.input.errors)}`);
    const payload: RuntimeEventPayload = { ...context, event: name, data: { input } };
    const result = await this.chain(this.match(name), 0, payload, (event) => {
      if (!method.input(event.data['input'])) throw new Error(`Invalid rewritten input for ${name}`);
      const result = Promise.resolve(method.handler(this.apiFor(method.pluginId, context), event, () => undefined));
      return this.loaded.get(method.pluginId)?.api === 'claude-mods' ? result : this.withTimeout(result);
    });
    if (method.output !== undefined && !method.output(result)) {
      throw new Error(`Invalid output from ${name}: ${this.validator.errorsText(method.output.errors)}`);
    }
    return result;
  }

  async openSite(input: { component: string; surface?: RuntimeRenderSurface; props?: Record<string, unknown> }, context: RuntimeContext): Promise<string | undefined> {
    await this.ready;
    return this.runCore(async () => {
      const id = `site:${input.component}`;
      for (const [pluginId, plugin] of this.loaded) {
        if (!plugin.capabilities.has('ui')) continue;
        try {
          const event = { ...context, event: 'ui.render', data: { surface: input.surface ?? 'terminal', component: input.component, requestId: id, props: input.props ?? {}, viewport: { columns: 80, rows: 20 } } };
          const tree = await this.chain(this.match('ui.render').filter(handler => handler.pluginId === pluginId), 0, event, () => undefined);
          if (tree === undefined) continue;
          validateElement(tree);
          this.panes.set(this.paneKey(context, id), { id, title: input.component, pluginId, sessionId: context.sessionId, component: input.component, props: input.props });
          this.change.fire();
          return id;
        } catch (error) { this.log.warn(`Plugin render site failed: ${input.component}`, { pluginId, error }); }
      }
      return undefined;
    });
  }

  async renderSite(input: RuntimeSiteRequest, context: RuntimeContext): Promise<RuntimeElement | undefined> {
    await this.ready;
    if (this.bootstrap.args.nonInteractive) return undefined;
    if (input.defaultTree !== undefined) validateElement(input.defaultTree);
    return this.runCore(async () => {
      this.renderClients.set(`${this.contextKey(context)}\0${context.clientId ?? ''}`, { sessionId: context.sessionId, surface: input.surface ?? 'terminal', seen: Date.now() });
      const data = { surface: input.surface ?? 'terminal', component: input.component, requestId: input.requestId ?? `site:${input.component}`, clientId: context.clientId, __siteComponent: input.component, props: { ...input.props, bodyColumns: input.width, maxRows: input.rows }, viewport: { columns: input.width, rows: input.rows } };
      const terminal = (event: RuntimeEventPayload) => {
        if (input.defaultTree !== undefined) {
          const props = event.data['props'] as Record<string, unknown> | undefined;
          const field = input.component === 'Spinner' ? 'word' : input.component === 'ContextUsage' ? 'text' : undefined;
          if (field !== undefined && typeof props?.[field] === 'string' && props[field] !== input.props?.[field] && input.defaultTree.type === 'Text') return { ...input.defaultTree, children: [props[field]] };
          return input.defaultTree;
        }
        if (input.component !== 'StatusLine' && input.component !== 'Toast') return undefined;
        const entries = [...this.chrome.values()].filter(entry => entry.sessionId === context.sessionId);
        const children = entries.flatMap(entry => {
          const text = input.component === 'StatusLine' ? entry.status : entry.toast;
          return text ? [{ type: 'Text' as const, props: { dimColor: input.component === 'StatusLine' }, children: [text] }] : [];
        });
        return children.length === 0 ? undefined : { type: 'Box' as const, props: { flexDirection: 'column' }, children };
      };
      const tree = await this.chain(this.match('ui.render').filter(handler => this.loaded.get(handler.pluginId)?.capabilities.has('ui')), 0, { ...context, event: 'ui.render', data }, terminal);
      if (tree !== undefined) validateElement(tree);
      if (!this.hasHandlers('kimi.ui.rendered')) return tree as RuntimeElement | undefined;
      const result = await this.chain(this.match('kimi.ui.rendered').filter(handler => this.loaded.get(handler.pluginId)?.capabilities.has('ui')), 0, { ...context, event: 'kimi.ui.rendered', data: { ...data, tree } }, event => event.data['tree']);
      if (result !== undefined) validateElement(result);
      return result as RuntimeElement | undefined;
    });
  }

  async dispatchSiteKey(input: { component: string; requestId?: string; key: string }, context: RuntimeContext): Promise<void> {
    await this.ready;
    if (this.bootstrap.args.nonInteractive) throw new Error('UI actions require an interactive host');
    if (!input.key.startsWith('callback:')) {
      await this.runCore(()=>this.interaction.run(true,()=>this.invoke('ui.key',{component:input.component,requestId:input.requestId ?? `site:${input.component}`,key:input.key},context,()=>undefined)));
      return;
    }
    const callback = JSON.parse(input.key.slice('callback:'.length)) as { handle: string; value?: unknown };
    await this.runCore(() => this.interaction.run(true, () => this.mods.interactSite(input.component, input.requestId ?? `site:${input.component}`, callback, context)));
  }

  async renderPane(id: string, width: number, context: RuntimeContext = { cwd: process.cwd() }, viewport: { rows?: number; placement?: 'dock' | 'inline'; surface?: RuntimeRenderSurface } = {}): Promise<RuntimeElement | undefined> {
    await this.ready;
    return this.runCore(async () => {
      const pane = this.panes.get(this.paneKey(context, id));
      if (pane === undefined) return undefined;
      this.renderClients.set(`${this.contextKey(context)}\0${context.clientId ?? ''}`, { sessionId: context.sessionId, surface: viewport.surface ?? 'terminal', seen: Date.now() });
      const event: RuntimeEventPayload = { ...context, event: 'ui.render', data: { surface: viewport.surface ?? 'terminal', component: pane.component ?? 'Pane', requestId: id, width, viewport: { columns: width, rows: viewport.rows ?? pane.rows ?? 20 }, props: { ...pane.props, bodyColumns: width, maxRows: viewport.rows ?? pane.rows ?? 20, id, title: pane.title, placement: viewport.placement ?? 'inline', columns: width, rows: viewport.rows ?? pane.rows ?? 20, viewId: context.clientId ?? id }, clientId: context.clientId } };
      const tree = await this.chain(this.match('ui.render').filter((h) => h.pluginId === pane.pluginId), 0, event, () => undefined);
      if (tree === undefined) return undefined;
      validateElement(tree);
      return tree;
    });
  }

  async closePane(id: string, context: RuntimeContext): Promise<void> {
    await this.ready;
    const key = this.paneKey(context,id);
    const pane = this.panes.get(key);
    if (pane === undefined) return;
    this.mods.close(pane.pluginId,id,context);
    this.panes.delete(key);
    for (const [client,view] of this.views) if (client.startsWith(this.contextKey(context)+'\0') && view.paneId === id) this.views.set(client,{agentId:view.agentId,revision:view.revision+1});
    this.change.fire();
  }

  async dispatchKey(id: string, key: string, context: RuntimeContext = { cwd: process.cwd() }): Promise<void> {
    await this.ready;
    return this.runCore(async () => {
      const pane = this.panes.get(this.paneKey(context, id));
      if (pane === undefined) throw new Error(`Plugin pane is no longer open: ${id}`);
      if (key.startsWith('callback:')) {
        await this.interaction.run(true, () => this.mods.interact(pane.pluginId, id, JSON.parse(key.slice(9)) as { handle: string; value?: unknown }, context));
        this.change.fire();
        return;
      }
      const event: RuntimeEventPayload = { ...context, event: 'ui.key', data: { paneId: id, key, clientId: context.clientId } };
      await this.interaction.run(true, () => this.chain(this.match('ui.key').filter((h) => h.pluginId === pane.pluginId), 0, event, () => undefined));
      this.change.fire();
    });
  }

  hasHandlers(event: string): boolean { return this.match(event).length > 0; }

  summary(): Record<string, number> {
    return Object.fromEntries([...this.byEvent].map(([event, handlers]) => [event, handlers.length]));
  }

  async dispatch(event: string, args: RuntimeDispatchArgs): Promise<HookResult[]> {
    await this.ready;
    const payload: RuntimeEventPayload = { event, sessionId: args.sessionId, cwd: args.cwd, data: args.data ?? {} };
    try {
      const result = await this.chain(this.match(event, args.matcherValue), 0, payload, () => undefined);
      if (result !== null && typeof result === 'object' && 'block' in result && typeof result.block === 'string') return [{ action: 'block', reason: result.block }];
      return [];
    } catch (error) {
      this.log.warn(`Runtime hook failed: ${event}`, { error });
      return [];
    }
  }

  private match(event: string, matcherValue?: string): LoadedHandler[] {
    return [...this.byEvent].filter(([pattern]) => matchName(pattern, event)).flatMap(([, handlers]) => handlers).filter((h) => h.matcher === undefined || (matcherValue !== undefined && h.matcher.test(matcherValue))).toSorted((a, b) => a.order - b.order);
  }

  private async chain(handlers: readonly LoadedHandler[], index: number, event: RuntimeEventPayload, terminal: (event: RuntimeEventPayload) => unknown): Promise<unknown> {
    const current = handlers[index];
    if (current === undefined) return terminal(event);
    const frame = `${this.contextKey(event)}\0${event.event}\0${current.order}`;
    const active = this.hookFrames.getStore() ?? new Set<string>();
    const mods = this.loaded.get(current.pluginId)?.api === 'claude-mods';
    if (!mods && active.has(frame)) return this.chain(handlers, index + 1, event, terminal);
    let called = false;
    const next = (rewritten: RuntimeEventPayload = event): Promise<unknown> => {
      if (!mods && called && event.event !== 'tool.call') throw new Error('Runtime handler called next more than once');
      called = true;
      return this.chain(handlers, index + 1, rewritten, terminal);
    };
    return this.hookFrames.run(new Set([...active, frame]), () => mods ? Promise.resolve(current.handler(this.apiFor(current.pluginId, event), event, next)) : this.withTimeout(Promise.resolve(current.handler(this.apiFor(current.pluginId, event), event, next))));
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Runtime handler timed out')), HANDLER_TIMEOUT_MS);
        timer.unref();
      })]);
    } finally { clearTimeout(timer); }
  }

  private apiFor(pluginId: string, context: RuntimeContext): RuntimePluginApi {
    const plugin = this.loaded.get(pluginId);
    if (plugin === undefined) throw new Error(`Plugin runtime is unloaded: ${pluginId}`);
    const bindingSignal = this.contexts.get(this.contextKey(context))?.signal;
    const lifetimeSignal = bindingSignal === undefined ? plugin.controller.signal : AbortSignal.any([plugin.controller.signal, bindingSignal]);
    const requireCapability = (capability: RuntimeCapability): void => {
      if (!plugin.capabilities.has(capability)) throw new Error(`Plugin ${pluginId} requires runtime capability: ${capability}`);
      plugin.controller.signal.throwIfAborted();
      bindingSignal?.throwIfAborted();
    };
    const stateKey = `${pluginId}\0${this.contextKey(context)}\0view:${context.clientId ?? ''}`;
    const adapter = (): RuntimeContextAdapter => {
      const bound = this.contexts.get(this.contextKey(context));
      if (bound === undefined) throw new Error('This operation requires an active agent session');
      bound.signal.throwIfAborted();
      return bound;
    };
    const stateFor = (scope: string): RuntimePluginApi['state'] => ({
      get: <T>(key: string) => { requireCapability('state'); return this.states.get(scope)?.get(key) as T | undefined; },
      set: (key, value) => {
        requireCapability('state');
        let state = this.states.get(scope);
        if (state === undefined) { state = new Map(); this.states.set(scope, state); }
        state.set(key, value);
        this.change.fire();
      },
    });
    const signal = context.signal === undefined ? lifetimeSignal : AbortSignal.any([lifetimeSignal, context.signal]);
    const operationSignal = (extra?: AbortSignal): AbortSignal => this.execution.signal(extra === undefined ? lifetimeSignal : AbortSignal.any([lifetimeSignal, extra]), context.signal);
    return this.execution.api<RuntimePluginApi>(pluginId, {
      pluginId, context, signal,
      log: {
        info: (message) => { requireCapability('log'); this.log.info(`[${pluginId}] ${message}`); },
        warn: (message) => { requireCapability('log'); this.log.warn(`[${pluginId}] ${message}`); },
      },
      store: {
        append: async (key, value) => { requireCapability('store'); await plugin.store.append(key, value); },
        readLog: async <T>(key: string) => { requireCapability('store'); return plugin.store.readLog<T>(key); },
        keys: async () => { requireCapability('store'); return Object.keys(await plugin.store.read()); },
        get: async <T>(key: string) => { requireCapability('store'); return (await plugin.store.read())[key] as T | undefined; },
        set: async (key, value) => { requireCapability('store'); await plugin.store.update(key, () => value); this.change.fire(); },
        delete: async (key) => { requireCapability('store'); await plugin.store.update(key, () => undefined); this.change.fire(); },
        update: async <T>(key: string, update: (value: T | undefined) => T) => {
          requireCapability('store');
          const value = await plugin.store.update(key, update);
          this.change.fire();
          return value as T;
        },
      },
      state: stateFor(`${pluginId}\0${this.contextKey(context)}\0state`),
      view: stateFor(stateKey),
      agent: {
        run: (options) => { requireCapability('agent'); return adapter().runAgent({ ...options, parentToolCallId: context.toolCallId ?? options.parentToolCallId, signal: operationSignal(options.signal) }); },
        list: () => { requireCapability('agent'); const bound = adapter(); if (bound.listAgents === undefined) throw new Error('Agent listing is unavailable'); return bound.listAgents(); },
        stop: async (id) => { requireCapability('agent'); const bound = adapter(); if (bound.stopAgent === undefined) throw new Error('Agent control is unavailable'); await bound.stopAgent(id); },
      },
      tool: {
        list: () => { requireCapability('tools'); const bound = adapter(); if (bound.listTools === undefined) throw new Error('Tool listing is unavailable'); return bound.listTools(); },
        register: (spec) => { requireCapability('tools'); return this.registerTool(pluginId, spec, context); },
        call: (input) => { requireCapability('tools'); const bound = adapter(); if (bound.callTool === undefined) throw new Error('Tool execution is unavailable'); return bound.callTool(input, operationSignal()); },
        check: (input) => { requireCapability('tools'); const bound = adapter(); if (bound.checkTool === undefined) throw new Error('Tool checks are unavailable'); return bound.checkTool(input, operationSignal()); },
      },
      prompt: {
        compose: () => { requireCapability('prompt'); const bound = adapter(); if (bound.composePrompt === undefined) throw new Error('Prompt composition is unavailable'); return bound.composePrompt(); },
        context: input => { requireCapability('prompt'); return this.invoke('prompt.context', input as unknown as Record<string, unknown>, context, e => synchronizePromptContext(e, e)) as Promise<import('./runtime').RuntimePromptContext>; },
      },
      fs: { ancestors: input => { requireCapability('fs'); const bound = adapter(); if (bound.ancestors === undefined) throw new Error('Filesystem ancestors are unavailable'); return bound.ancestors(input); } },
      session: {
        root: () => { requireCapability('session'); const bound = adapter(); if (bound.sessionPath === undefined) throw new Error('Session paths are unavailable'); return bound.sessionPath('root'); },
        cwd: () => { requireCapability('session'); const bound = adapter(); if (bound.sessionPath === undefined) throw new Error('Session paths are unavailable'); return bound.sessionPath('cwd'); },
        id: async () => { requireCapability('session'); return context.sessionId; },
        model: async () => { requireCapability('session'); return adapter().sessionModel?.(); },
        usage: async () => { requireCapability('session'); const bound = adapter(); if (bound.sessionUsage === undefined) throw new Error('Session usage is unavailable'); return bound.sessionUsage(); },
        surfaces: async () => { requireCapability('session'); if (this.bootstrap.args.nonInteractive) return []; const clients = [...this.renderClients.values()].filter(client => client.sessionId === context.sessionId && Date.now() - client.seen < 30000); return clients.length > 0 ? [...new Set(clients.map(client => client.surface))] : ['terminal']; },
        version: async () => { requireCapability('session'); return this.bootstrap.clientIdentity.version; },
      },
      env: { get: name => { requireCapability('env'); const bound = adapter(); if (bound.getEnv === undefined) throw new Error('Environment reads are unavailable'); return bound.getEnv(name); } },
      domains: { call: (name, input) => { requireCapability('domains'); return this.call(name, input, context); } },
      script: { run: async (options) => {
        requireCapability('script');
        const { runRuntimeScript } = await import('./runtimeScript');
        const scriptSignal = operationSignal(options.signal);
        return runRuntimeScript({ ...options, signal: scriptSignal });
      } },
      tasks: {
        list: () => { requireCapability('tasks'); return adapter().activities(); },
        output: (id) => { requireCapability('tasks'); return adapter().output(id); },
        start: (options, work) => {
          requireCapability('tasks');
          const bound = adapter();
          const key = `${pluginId}\0${this.contextKey(context)}\0${options.id}`;
          if (this.jobs.has(key)) throw new Error(`Plugin task is already running: ${options.id}`);
          const controller = new AbortController();
          const signal = AbortSignal.any([controller.signal, plugin.controller.signal, bound.signal]);
          let finish!: () => void;
          const completion = new Promise<void>(resolve => { finish = resolve; });
          const execute = async (taskSignal: AbortSignal): Promise<unknown> => {
            try { return await this.mods.root(() => this.execution.detached(pluginId, () => work(taskSignal))); }
            finally { this.jobs.delete(key); finish(); this.change.fire(); }
          };
          this.jobs.set(key, { controller, completion });
          let taskId: string;
          try {
            taskId = bound.startTask?.({ ...options, pluginId, parentToolCallId: context.toolCallId }, execute, signal) ?? options.id;
            if (bound.startTask === undefined) void execute(signal).catch((error: unknown) => this.log.warn(`[${pluginId}] Task ${options.title} ended`, { error }));
          } catch (error) { this.jobs.delete(key); finish(); throw error; }
          this.change.fire();
          return taskId;
        },
        cancel: async (id) => {
          requireCapability('tasks');
          const job = this.jobs.get(`${pluginId}\0${this.contextKey(context)}\0${id}`);
          if (job === undefined) { const bound = adapter(); if (bound.stopTask === undefined) throw new Error('Native task control is unavailable'); await bound.stopTask(id); return; }
          job.controller.abort(new Error('Stopped by user'));
          await job.completion.catch(() => undefined);
        },
      },
      clock: {
        every: (ms, fn) => { requireCapability('clock'); return this.addTimer(plugin, ms, () => this.mods.root(() => this.execution.detached(pluginId, fn)), true); },
        after: (ms, fn) => { requireCapability('clock'); return this.addTimer(plugin, ms, () => this.mods.root(() => this.execution.detached(pluginId, fn)), false); },
      },
      process: { run: (args, options) => {
        requireCapability('process');
        const bound = this.contexts.get(this.contextKey(context));
        const runOptions = { ...options, cwd: options?.cwd ?? context.cwd, signal: operationSignal(options?.signal) };
        return bound === undefined ? this.runProcess(args, runOptions) : bound.runProcess(args, runOptions);
      } },
      ui: {
        status: async text => {
          requireCapability('ui');
          if (text !== undefined && (typeof text !== 'string' || text.length > 10000)) throw new Error('Invalid plugin status text');
          if (this.bootstrap.args.nonInteractive) return;
          const key = `${pluginId}\0${this.contextKey(context)}`;
          this.chrome.set(key, { ...this.chrome.get(key), pluginId, sessionId: context.sessionId, status: text });
          this.change.fire();
        },
        toast: async (text, options) => {
          requireCapability('ui');
          if (typeof text !== 'string' || text.length > 10000) throw new Error('Invalid plugin toast text');
          if (this.bootstrap.args.nonInteractive) return;
          const key = `${pluginId}\0${this.contextKey(context)}`;
          const entry = { ...this.chrome.get(key), pluginId, sessionId: context.sessionId, toast: text, toastToken: {} };
          this.chrome.set(key, entry);
          this.change.fire();
          this.addTimer(plugin, Math.max(100, Math.min(options?.timeoutMs ?? 4000, 60000)), () => {
            const current = this.chrome.get(key);
            if (current?.toastToken !== entry.toastToken) return;
            this.chrome.set(key, { ...current, toast: undefined, toastToken: undefined });
            this.change.fire();
          }, false);
        },
        view: async (input) => {
          requireCapability('ui');
          if (!this.interaction.getStore() || this.bootstrap.args.nonInteractive) return { isViewed: false };
          const result = await adapter().viewAgent?.(input.agentId);
          if (result?.isViewed !== true) return { isViewed: false };
          this.views.set(`${this.contextKey(context)}\0${context.clientId ?? ''}`, { agentId: input.agentId, revision: this.getView(context).revision + 1 });
          this.change.fire();
          return result;
        },
        open: async ({ id, title, columns, rows, focus, closeOnEscape }) => {
          requireCapability('ui');
          const key = this.paneKey(context, id);
          const previous = this.panes.get(key);
          if (previous !== undefined && previous.pluginId !== pluginId) throw new Error(`Pane id is already owned: ${id}`);
          this.panes.set(key, { id, title, pluginId, columns, rows, closeOnEscape, sessionId: context.sessionId });
          if (this.interaction.getStore() && !this.bootstrap.args.nonInteractive && focus !== false) this.views.set(`${this.contextKey(context)}\0${context.clientId ?? ''}`, { paneId: id, revision: this.getView(context).revision + 1 });
          this.change.fire();
        },
        close: async ({ id }) => {
          requireCapability('ui');
          const key = this.paneKey(context, id);
          if (this.panes.get(key)?.pluginId !== pluginId) throw new Error('A plugin cannot close another plugin pane');
          await this.closePane(id, context);
        },
        invalidate: event => { requireCapability('ui'); if (event === 'prompt.context') this.generation++; this.change.fire(); },
      },
    });
  }

  private contextKey(context: RuntimeContext): string { return `${context.sessionId ?? ''}\0${context.agentId ?? 'main'}`; }
  private paneKey(context: RuntimeContext, id: string): string { return `${context.sessionId ?? ''}\0${id}`; }

  private async registerTool(pluginId: string, spec: RuntimeToolSpec, context: RuntimeContext): Promise<{ tool: string }> {
    if (context.sessionId === undefined) throw new Error('Tools can only be registered in a session');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(spec.name) || typeof spec.description !== 'string' || !spec.description.trim()) throw new Error('Invalid plugin tool definition');
    const name = `mcp__${pluginId.replaceAll(/[^A-Za-z0-9_-]/g, '_')}__${spec.name}`;
    const method = `${pluginId}.tool.${spec.name}`;
    const key = `${context.sessionId}\0${method}`;
    if (this.toolsFor(context).some(tool => tool.name === name && tool.method !== method) || this.dynamicTools.get(key) === undefined && this.contexts.get(this.contextKey(context))?.hasTool?.(name)) throw new Error(`Tool name is already registered: ${name}`);
    const inputSchema = spec.inputSchema ?? { type: 'object' };
    const validate = this.validator.compile(inputSchema);
    const definition: RuntimePublishedTool = { pluginId, name, method, description: spec.description, inputSchema, isDeferred: spec.isDeferred };
    this.dynamicTools.set(key, { context: context.sessionId, definition, validate });
    this.change.fire();
    return { tool: name };
  }

  private addTimer(plugin: LoadedPlugin, ms: number, fn: () => void, repeat: boolean): { cancel(): void } {
    if (!Number.isFinite(ms) || ms < 1) throw new Error('Timer delay must be positive');
    const wrapped = (): void => {
      if (!repeat) plugin.timers.delete(handle);
      void Promise.resolve().then(fn).catch((error: unknown) => { this.log.warn('Plugin timer failed', { error }); });
    };
    const timer = repeat ? setInterval(wrapped, ms) : setTimeout(wrapped, ms);
    timer.unref();
    const handle = { cancel: () => { clearInterval(timer); clearTimeout(timer); plugin.timers.delete(handle); } };
    plugin.timers.add(handle);
    return handle;
  }

  private runProcess(args: readonly string[], options: { timeoutMs?: number; cwd?: string; input?: string; signal?: AbortSignal } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const [command, ...rest] = args;
      if (!command) throw new Error('process.run requires a command');
      const child = spawn(command, rest, { cwd: options.cwd, shell: false, signal: options.signal });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`process.run timed out: ${command}`)); }, options.timeoutMs ?? 30_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-MAX_PROCESS_OUTPUT); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-MAX_PROCESS_OUTPUT); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout, stderr }); });
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    });
  }

  private unload(): void {
    this.generation++;
    for (const plugin of this.loaded.values()) {
      plugin.controller.abort(new Error('Plugin unloaded'));
      for (const timer of plugin.timers) timer.cancel();
    }
    this.mods.reset();
    this.chrome.clear();
    this.dynamicTools.clear(); this.views.clear();
    this.loaded.clear(); this.byEvent.clear(); this.methods.clear(); this.commands.clear(); this.panes.clear(); this.states.clear();
  }

  private async reload(): Promise<void> {
    this.unload();
    this.change.fire();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.completion));
    await this.load();
    for (const adapter of this.contexts.values()) {
      if (adapter.context.agentId !== 'main' || adapter.signal.aborted) continue;
      await this.initializing.run(true, () => this.invoke('SessionStart', { source: 'reload' }, adapter.context, () => undefined));
    }
    this.change.fire();
  }

  private async load(): Promise<void> {
    if (!this.flags.enabled(PLUGIN_RUNTIME_FLAG_ID)) return;
    for (const summary of await this.plugins.listPlugins()) {
      if (!summary.enabled || summary.state !== 'ok') continue;
      try { await this.loadPlugin(summary.id); }
      catch (error) { this.log.warn(`Failed to load plugin runtime: ${summary.id}`, { error }); }
    }
    await this.mods.build();
    const names = new Set<string>();
    for (const [id, plugin] of this.loaded) {
      const info = await this.plugins.getPluginInfo({ id });
      for (const definition of info.manifest?.runtime?.tools ?? []) {
        if (!plugin.capabilities.has('tools')) throw new Error(`Plugin ${id} requires tools capability`);
        const method = `${id}.${definition.method}`;
        if (names.has(definition.name) || !this.methods.has(method)) throw new Error(`Invalid runtime tool ${definition.name}: duplicate name or missing method`);
        names.add(definition.name);
        this.validator.compile(definition.inputSchema);
        (plugin.tools as RuntimePublishedTool[]).push({ ...definition, method, pluginId: id });
      }
    }
  }

  private async loadPlugin(id: string): Promise<void> {
    const info = await this.plugins.getPluginInfo({ id });
    const runtime = info.manifest?.runtime;
    if (runtime === undefined) return;
    const home = this.bootstrap.homeDir;
    const plugin: LoadedPlugin = { api: runtime.api, capabilities: new Set(runtime.capabilities), controller: new AbortController(), timers: new Set(), store: new RuntimeStore(path.join(home, 'plugin-runtime', `${encodeURIComponent(id)}.json`)), tools: [] };
    const root = await realpath(info.root);
    this.loaded.set(id, plugin);
    const register = ((event: string, matcherOrHandler: string | RuntimeHandler, handler?: RuntimeHandler) => {
      if (!plugin.capabilities.has('events')) throw new Error(`Plugin ${id} requires events capability`);
      const entry: LoadedHandler = { order: this.handlerOrder++, pluginId: id, handler: handler ?? matcherOrHandler as RuntimeHandler, matcher: handler === undefined ? undefined : new RegExp(matcherOrHandler as string) };
      const handlers = this.byEvent.get(event) ?? [];
      handlers.push(entry);
      this.byEvent.set(event, handlers);
    }) as RuntimeRegistrar;
    register.command = (name, description, handler) => {
      if (!plugin.capabilities.has('command')) throw new Error(`Plugin ${id} requires command capability`);
      const qualified = `${id}:${name}`;
      this.commands.set(qualified, { name: qualified, description, pluginId: id, handler });
    };
    register.domain = (name, methods) => {
      if (!plugin.capabilities.has('domains')) throw new Error(`Plugin ${id} requires domains capability`);
      for (const [method, definition] of Object.entries(methods)) this.addMethod(`${id}.${name}.${method}`, id, definition);
    };
    try {
      for (const modulePath of runtime.modules) {
        if (!modulePath.startsWith('./')) throw new Error('Runtime module path must start with ./');
        const absolute = await realpath(path.resolve(root, modulePath));
        const relative = path.relative(root, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Runtime module escapes plugin directory');
        const imported = runtime.api === 'claude-mods'
          ? await (await import('./modsLoader')).loadModsModule(absolute, home)
          : await import(`${pathToFileURL(absolute).href}?runtime=${Date.now()}`) as RuntimeModule;
        if (typeof imported.register !== 'function') throw new Error(`Runtime module has no register export: ${modulePath}`);
        const options = { ...runtime.options, ...this.config?.get<PluginRuntimeSettings>(PLUGIN_RUNTIME_SETTINGS)?.options[id] };
        if (runtime.optionSchema !== undefined && !this.validator.validate(runtime.optionSchema, options)) throw new Error(`Invalid options for ${id}: ${this.validator.errorsText()}`);
        if (runtime.api === 'claude-mods') await this.withTimeout(this.mods.load(id, register, imported.register as import('./mods').Register, options));
        else await this.withTimeout(Promise.resolve((imported.register as (on: RuntimeRegistrar, options: ModsEvent) => unknown)(register, options)));
      }
    } catch (error) {
      plugin.controller.abort(error);
      for (const timer of plugin.timers) timer.cancel();
      this.mods.unload(id);
      this.loaded.delete(id);
      for (const [event, handlers] of this.byEvent) this.byEvent.set(event, handlers.filter((h) => h.pluginId !== id));
      for (const [name, method] of this.methods) if (method.pluginId === id) this.methods.delete(name);
      for (const [name, command] of this.commands) if (command.pluginId === id) this.commands.delete(name);
      throw error;
    }
  }

  private addMethod(name: string, pluginId: string, method: RuntimeMethod): void {
    if (this.methods.has(name)) throw new Error(`Duplicate plugin method: ${name}`);
    this.methods.set(name, { pluginId, handler: method.handler, input: this.validator.compile(method.input), output: method.output === undefined ? undefined : this.validator.compile(method.output) });
  }
}

function validateElement(value: unknown, depth = 0, budget = { nodes: 0, characters: 0 }): asserts value is RuntimeElement {
  if (++budget.nodes > 10_000 || depth > 32 || value === null || typeof value !== 'object') throw new Error('Invalid plugin render tree');
  const node = value as Record<string, unknown>;
  if (node['type'] === 'Svg') {
    const props = node['props'] as Record<string, unknown> | undefined;
    if (typeof props?.['source'] !== 'string' || props['source'].length > 1_000_000 || typeof props['alt'] !== 'string' || props['alt'].length > 4000) throw new Error('Invalid SVG source');
    for (const size of ['width','height']) if (props[size] !== undefined && (typeof props[size] !== 'number' || !Number.isFinite(props[size]) || props[size] <= 0 || props[size] > 10000)) throw new Error('Invalid SVG size');
    return;
  }
  if (['Box', 'Text', 'Button', 'Select', 'Input', 'Markdown', 'Code', 'Link'].includes(node['type'] as string)) {
    if (JSON.stringify(node).length > 4_000_000) throw new Error('Mods tree exceeds limit');
    if (node['children'] !== undefined && !Array.isArray(node['children'])) throw new Error('Invalid Mods children');
    for (const child of node['children'] as unknown[] ?? []) {
      if (typeof child === 'string') budget.characters += child.length;
      else validateElement(child,depth+1,budget);
    }
    if (budget.characters > 4_000_000) throw new Error('Mods tree exceeds limit');
    return;
  }
  for (const property of ['text', 'label', 'key', 'action', 'hotkey']) {
    const text = node[property];
    if (text !== undefined && typeof text !== 'string') throw new Error(`Invalid plugin element ${property}`);
    if (typeof text === 'string') budget.characters += text.length;
  }
  if (budget.characters > 4_000_000) throw new Error('Plugin render tree exceeds the text limit');
  if (node['type'] === 'text' && typeof node['text'] === 'string') {
    if (node['selected'] !== undefined && typeof node['selected'] !== 'boolean') throw new Error('Invalid plugin selection');
    if (node['color'] !== undefined && (typeof node['color'] !== 'string' || !['primary', 'success', 'error', 'warning', 'dim', 'muted', 'textStrong'].includes(node['color']))) throw new Error('Invalid plugin color');
    return;
  }
  if (node['type'] === 'button' && typeof node['label'] === 'string') return;
  if (node['type'] !== 'box' || (typeof node['direction'] !== 'string' || !['row', 'column'].includes(node['direction'])) || !Array.isArray(node['children'])) throw new Error('Invalid plugin render element');
  if (node['gap'] !== undefined && (typeof node['gap'] !== 'number' || !Number.isInteger(node['gap']) || node['gap'] < 0 || node['gap'] > 100)) throw new Error('Invalid plugin element gap');
  if (node['captureEscape'] !== undefined && typeof node['captureEscape'] !== 'boolean') throw new Error('Invalid plugin escape policy');
  for (const child of node['children']) {
    if (typeof child === 'string') {
      budget.characters += child.length;
      if (++budget.nodes > 10_000 || budget.characters > 4_000_000) throw new Error('Plugin render tree exceeds the item limit');
    } else validateElement(child, depth + 1, budget);
  }
}
