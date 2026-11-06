import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { RenderElement } from './mods';

import type { HookResult } from '#/features/externalHooks/internal/types';

export const RUNTIME_CAPABILITIES = ['events', 'log', 'store', 'clock', 'process', 'ui', 'state', 'agent', 'tasks', 'command', 'domains', 'script', 'tools', 'prompt', 'fs', 'env', 'session'] as const;

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export interface PluginRuntimeConfig {
  readonly api?: 'native' | 'claude-mods';
  readonly tools?: readonly RuntimeToolDefinition[];
  readonly modules: readonly string[];
  readonly capabilities: readonly RuntimeCapability[];
  readonly options?: Readonly<Record<string, unknown>>;
  readonly optionSchema?: Readonly<Record<string, unknown>>;
}

export interface RuntimeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly method: string;
  readonly inputSchema: Record<string, unknown>;
  readonly isDeferred?: boolean;
}

export interface RuntimePublishedTool extends RuntimeToolDefinition { readonly pluginId: string }

export interface RuntimeEventPayload {
  readonly event: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly cwd: string;
  readonly data: Record<string, unknown>;
}

export type RuntimeNext = (
  event?: RuntimeEventPayload,
) => unknown;

export interface RuntimeContext {
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly clientId?: string;
  readonly toolCallId?: string;
  readonly cwd: string;
}

export interface RuntimeAgentOptions {
  readonly prompt: string;
  readonly model: string;
  readonly label?: string;
  readonly profile?: string;
  readonly schema?: Record<string, unknown>;
  readonly parentToolCallId?: string;
  readonly parentRunId?: string;
  readonly notify?: boolean;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RuntimeAgentProgress) => void;
  readonly onStarted?: (agentId: string, taskId: string, model: string) => void;
}

export interface RuntimeAgentProgress {
  readonly model: string;
  readonly maxContextTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly toolCalls: number;
  readonly elapsedMs: number;
  readonly firstResponseAt?: number;
}

export interface RuntimeTaskOptions { readonly id: string; readonly title: string; readonly pluginId?: string; readonly parentToolCallId?: string }
export interface RuntimeToolSpec { readonly name: string; readonly description: string; readonly inputSchema?: Record<string, unknown>; readonly isDeferred?: boolean }
export interface RuntimeToolInfo { readonly name: string; readonly description: string; readonly inputSchema?: Record<string, unknown>; readonly source: string }
export interface RuntimeToolCall { readonly tool: string; readonly input?: unknown; readonly [key: string]: unknown }
export interface RuntimeToolResult { readonly result: unknown; readonly text?: string; readonly isError?: boolean }
export interface RuntimeToolCheck { readonly decision: 'allow' | 'deny' | 'ask'; readonly reason?: string }
export interface RuntimePromptSection { readonly id: string; readonly text: string; readonly scope: 'shared' | 'session' }
export interface RuntimePromptContext { readonly blocks: readonly { readonly name: string; readonly text: string }[]; readonly instructionFiles?: readonly import('#/agent/profile/instructionFile').InstructionFile[] }
export interface RuntimeAgentInfo { readonly id: string; readonly description: string; readonly status: string; readonly model?: string }
export interface RuntimeView { readonly paneId?: string; readonly agentId?: string; readonly revision: number }
export interface RuntimeSessionUsage {
  readonly startedAt: number;
  readonly context: { readonly tokens?: number; readonly window?: number; readonly percent?: number };
  readonly rateLimits: readonly { readonly kind: string; readonly percentUsed: number; readonly resetsAt?: string }[];
  readonly cost?: { readonly usd?: number };
}
export type RuntimeRenderSurface = 'terminal' | 'desktop' | 'mobile' | 'vscode';
export interface RuntimeSiteRequest { readonly component: string; readonly requestId?: string; readonly surface?: RuntimeRenderSurface; readonly width: number; readonly rows: number; readonly props?: Record<string, unknown>; readonly clientId?: string; readonly defaultTree?: RuntimeElement }
export interface RuntimeFsAncestorPart { readonly path: string; readonly content: string }
export interface RuntimeFsAncestor { readonly dir: string; readonly name: string; readonly content: string; readonly parts: readonly RuntimeFsAncestorPart[] }
export interface RuntimeFsAncestorsRequest { readonly names: readonly string[]; readonly of?: string; readonly below?: string }

export interface RuntimeAgentResult {
  readonly progress?: RuntimeAgentProgress;
  readonly agentId: string;
  readonly taskId: string;
  readonly text: string;
  readonly value?: unknown;
  readonly usage?: { readonly input: number; readonly output: number; readonly cache_read?: number; readonly cache_write?: number };
}

export interface RuntimeContextAdapter {
  readonly context: RuntimeContext;
  readonly signal: AbortSignal;
  runAgent(options: RuntimeAgentOptions): Promise<RuntimeAgentResult>;
  activities(): readonly RuntimeActivity[];
  output(id: string): Promise<string>;
  startTask?(options: RuntimeTaskOptions, work: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal): string;
  stopTask?(id: string): Promise<void>;
  listAgents?(): readonly RuntimeAgentInfo[];
  stopAgent?(id: string): Promise<void>;
  listTools?(): readonly RuntimeToolInfo[];
  hasTool?(name: string): boolean;
  callTool?(input: RuntimeToolCall, signal: AbortSignal): Promise<RuntimeToolResult>;
  checkTool?(input: RuntimeToolCall, signal: AbortSignal): Promise<RuntimeToolCheck>;
  composePrompt?(): Promise<{ sections: readonly RuntimePromptSection[] }>;
  viewAgent?(agentId?: string): Promise<{ isViewed: boolean }>;
  ancestors?(input: RuntimeFsAncestorsRequest): Promise<readonly RuntimeFsAncestor[]>;
  sessionPath?(kind: 'root' | 'cwd'): Promise<string>;
  sessionModel?(): Promise<string | undefined>;
  sessionUsage?(): Promise<RuntimeSessionUsage>;
  getEnv?(name: string): Promise<string | undefined>;
  readPromptContext?(): Promise<RuntimePromptContext> | undefined;
  inheritPromptContext?(context: Promise<RuntimePromptContext> | undefined): void;
  runProcess(args: readonly string[], options?: { timeoutMs?: number; cwd?: string; input?: string; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface RuntimeActivity {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly kind: string;
  readonly agentId?: string;
}

export interface RuntimeCommand {
  readonly name: string;
  readonly description: string;
  readonly pluginId: string;
}

export interface RuntimeMethod {
  readonly input: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
  readonly handler: RuntimeHandler;
}

export interface RuntimePluginApi {
  readonly pluginId: string;
  readonly context: RuntimeContext;
  readonly signal: AbortSignal;
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
  };
  readonly store: {
    keys(): Promise<string[]>;
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    update<T>(key: string, update: (value: T | undefined) => T): Promise<T>;
    append(key: string, value: unknown): Promise<void>;
    readLog<T>(key: string): Promise<T[]>;
  };
  readonly state: {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
  };
  readonly view: RuntimePluginApi['state'];
  readonly agent: {
    run(options: RuntimeAgentOptions): Promise<RuntimeAgentResult>;
    list(): readonly RuntimeAgentInfo[];
    stop(id: string): Promise<void>;
  };
  readonly tool: {
    list(): readonly RuntimeToolInfo[];
    register(spec: RuntimeToolSpec): Promise<{ tool: string }>;
    call(input: RuntimeToolCall): Promise<RuntimeToolResult>;
    check(input: RuntimeToolCall): Promise<RuntimeToolCheck>;
  };
  readonly prompt: { compose(): Promise<{ sections: readonly RuntimePromptSection[] }>; context(input: RuntimePromptContext): Promise<RuntimePromptContext> };
  readonly fs: { ancestors(input: RuntimeFsAncestorsRequest): Promise<readonly RuntimeFsAncestor[]> };
  readonly session: { root(): Promise<string>; cwd(): Promise<string>; id(): Promise<string | undefined>; model(): Promise<string | undefined>; usage(): Promise<RuntimeSessionUsage>; surfaces(): Promise<readonly string[]>; version(): Promise<string> };
  readonly env: { get(name: string): Promise<string | undefined> };
  readonly domains: { call(name: string, input: unknown): Promise<unknown> };
  readonly script: { run(options: RuntimeScriptOptions): Promise<unknown> };
  readonly tasks: {
    list(): readonly RuntimeActivity[];
    output(id: string): Promise<string>;
    start(options: RuntimeTaskOptions, work: (signal: AbortSignal) => Promise<unknown>): string;
    cancel(id: string): Promise<void>;
  };
  readonly clock: {
    every(ms: number, fn: () => void): { cancel(): void };
    after(ms: number, fn: () => void): { cancel(): void };
  };
  readonly process: {
    run(
      args: readonly string[],
      options?: { timeoutMs?: number; cwd?: string; input?: string; signal?: AbortSignal },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  readonly ui: {
    open(options: { id: string; title: string; columns?: number; rows?: number; focus?: boolean; closeOnEscape?: boolean }): Promise<void>;
    close(options: { id: string }): Promise<void>;
    invalidate(event?: 'ui.render' | 'prompt.context'): void;
    view(input: { agentId?: string }): Promise<{ isViewed: boolean }>;
    status(text?: string): Promise<void>;
    toast(text: string, options?: { timeoutMs?: number }): Promise<void>;
  };
}

export type RuntimeHandler = (
  api: RuntimePluginApi,
  event: RuntimeEventPayload,
  next: RuntimeNext,
) => unknown;

export interface RuntimeBlock {
  readonly block: string;
}

export type RuntimeUiColor = 'primary' | 'success' | 'error' | 'warning' | 'dim' | 'muted' | 'textStrong';

export type RuntimeElement =
  | {
      readonly type: 'box';
      readonly direction: 'row' | 'column';
      readonly gap?: number;
      readonly captureEscape?: boolean;
      readonly children: readonly (RuntimeElement | string)[];
    }
  | { readonly type: 'text'; readonly text: string; readonly color?: RuntimeUiColor; readonly key?: string; readonly selected?: boolean }
  | { readonly type: 'button'; readonly label: string; readonly hotkey?: string; readonly action?: string }
  | RenderElement;

export interface PluginPaneInfo {
  readonly closeOnEscape?: boolean;
  readonly id: string;
  readonly title: string;
  readonly pluginId: string;
  readonly columns?: number;
  readonly rows?: number;
}

export interface RuntimeScriptOptions {
  readonly source: string;
  readonly args?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly invoke: (method: string, input: unknown) => Promise<unknown>;
}

export type RuntimeModule = {
  register(on: RuntimeRegistrar): void | Promise<void>;
};

export interface RuntimeRegistrar {
  (event: string, handler: RuntimeHandler): void;
  (event: string, matcher: string, handler: RuntimeHandler): void;
  command(name: string, description: string, handler: RuntimeHandler): void;
  domain(name: string, methods: Readonly<Record<string, RuntimeMethod>>): void;
}

export interface IPluginRuntimeHost {
  readonly generation: number;
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  runCore<T>(work: () => T): T;
  dispatch(event: string, args: RuntimeDispatchArgs): Promise<HookResult[]>;
  hasHandlers(event: string): boolean;
  summary(): Record<string, number>;
  listPanes(context?: RuntimeContext): readonly PluginPaneInfo[];
  openSite(input: { component: string; surface?: RuntimeRenderSurface; props?: Record<string, unknown> }, context: RuntimeContext): Promise<string | undefined>;
  renderSite(input: RuntimeSiteRequest, context: RuntimeContext): Promise<RuntimeElement | undefined>;
  dispatchSiteKey(input: { component: string; requestId?: string; key: string }, context: RuntimeContext): Promise<void>;
  renderPane(id: string, width: number, context?: RuntimeContext, viewport?: { rows?: number; placement?: 'dock' | 'inline'; surface?: RuntimeRenderSurface }): Promise<RuntimeElement | undefined>;
  closePane(id: string, context: RuntimeContext): Promise<void>;
  dispatchKey(id: string, key: string, context?: RuntimeContext): Promise<void>;
  listTools(): readonly RuntimePublishedTool[];
  toolsFor(context: RuntimeContext): readonly RuntimePublishedTool[];
  invoke(event: string, input: Record<string, unknown>, context: RuntimeContext, terminal: (input: Record<string, unknown>) => unknown): Promise<unknown>;
  getView(context: RuntimeContext): RuntimeView;
  listCommands(): Promise<readonly RuntimeCommand[]>;
  runCommand(name: string, args: string, context: RuntimeContext): Promise<unknown>;
  call(name: string, input: unknown, context: RuntimeContext): Promise<unknown>;
  bindContext(adapter: RuntimeContextAdapter): { dispose(): void };
  inheritContext(parent: RuntimeContext, agentId: string): void;
  readonly onDidChange: import('#/_base/event').Event<void>;
}

export interface RuntimeDispatchArgs {
  readonly matcherValue?: string;
  readonly sessionId?: string;
  readonly cwd: string;
  readonly data?: Record<string, unknown>;
}

export const IPluginRuntimeHost: ServiceIdentifier<IPluginRuntimeHost> =
  createDecorator<IPluginRuntimeHost>('pluginRuntimeHost');
