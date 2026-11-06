import type { RuntimeRenderSurface, RuntimePluginApi, RuntimeAgentInfo, RuntimeAgentOptions, RuntimeToolSpec, RuntimeToolInfo, RuntimeToolCall, RuntimeToolCheck, RuntimeToolResult } from './runtime';

export interface PluginState {}
export interface StateFamily<T> { readonly byId: T }
export interface StateAddress { readonly plugin: string; readonly key: string; readonly id?: string }
export interface StateRead<T = unknown> { readonly value: T | undefined; readonly version: number }
export interface StateSetOptions { readonly ifVersion?: number }
export interface StateSetResult { readonly isSet: boolean; readonly version: number }
export interface Atom<T> { readonly ref: StateAddress; readonly initial: T; readonly shape?: string }
export interface AtomOptions { readonly shape: string }
export interface Shaped<T> { readonly shape: string; readonly value: T }
export type ShapedValue<T> = T extends Shaped<infer V> ? V : never;
export type StateValue<P extends keyof PluginState, K extends keyof PluginState[P]> = PluginState[P][K] extends StateFamily<infer T> ? T : PluginState[P][K];
export type StateRef<P extends Extract<keyof PluginState, string>, K extends keyof PluginState[P] & string> = { readonly plugin: P; readonly key: K } & (PluginState[P][K] extends StateFamily<unknown> ? { readonly id: string } : { readonly id?: undefined });
export type StateDollar = Pick<EngineInterface, 'state'>;
export { atom, read, update } from './modsState';
export interface RenderPropsOf {
  Pane: { id: string; title: string; placement: 'dock' | 'inline'; columns: number; rows: number };
  AbovePrompt: Record<string, unknown>;
  Spinner: { word: string; message: string; suffix: string; mode: string };
  ContextUsage: { text: string; tokens?: number; window?: number; percent?: number };
}
export interface RenderInput<C extends keyof RenderPropsOf = keyof RenderPropsOf, P extends RuntimeRenderSurface = RuntimeRenderSurface> {
  readonly surface: P;
  readonly component: C;
  readonly requestId: string;
  readonly viewport?: { columns: number; rows: number };
  readonly props: Record<string, unknown>;
}
export type RenderNode = RenderElement | string;
export type RenderElement = {
  readonly type: 'Box' | 'Text' | 'Button' | 'Select' | 'Input' | 'Markdown' | 'Code' | 'Link' | 'Svg';
  readonly props?: Record<string, unknown>;
  readonly children?: readonly RenderNode[];
};
export type ElementProps = Record<string, unknown> & { children?: RenderNode | readonly RenderNode[] };
export interface Elements {
  Svg(this: void, props: ElementProps & { source: string; alt: string; width?: number; height?: number }): RenderElement;
  Box(this: void, props: ElementProps): RenderElement;
  Text(this: void, props: ElementProps): RenderElement;
  Button(this: void, props: ElementProps & { key: string; onPress: (e: Record<string, unknown>) => unknown }): RenderElement;
  Select(this: void, props: ElementProps & { key: string; options: readonly { value: string; label?: string }[]; value?: string; onSelect: (value: string, e: Record<string, unknown>) => unknown }): RenderElement;
  Input(this: void, props: ElementProps & { key: string; onInput?: (value: string, e: Record<string, unknown>) => unknown; onSubmit: (value: string, e: Record<string, unknown>) => unknown }): RenderElement;
  Markdown(this: void, props: ElementProps): RenderElement;
  Code(this: void, props: ElementProps): RenderElement;
  Link(this: void, props: ElementProps): RenderElement;
}
export interface EngineInterface {
  plugin: { name: string };
  ui: {
    resolve(input: RenderInput): Elements;
    open(options: { id: string; title?: string; focus?: boolean; closeOnEscape?: boolean; columns?: number; rows?: number }): Promise<{ isPlaced: boolean; reason?: string }>;
    close(options: { id: string }): Promise<void>;
    panes(): Promise<readonly { id: string; title: string }[]>;
    invalidate(event?: 'ui.render' | 'prompt.context'): void;
    log(text: string, options?: { to?: 'debug' | 'transcript' }): void;
    view(input: { agentId?: string }): Promise<{ isViewed: boolean }>;
    status(text?: string): Promise<void>;
    toast(text: string, options?: { timeoutMs?: number }): Promise<void>;
  };
  state: {
    get<P extends keyof PluginState, K extends keyof PluginState[P] & string>(ref: StateAddress & { plugin: P; key: K }): Promise<StateRead<StateValue<P, K>>>;
    set<P extends keyof PluginState, K extends keyof PluginState[P] & string>(ref: StateAddress & { plugin: P; key: K }, value: StateValue<P, K>, options?: StateSetOptions): Promise<StateSetResult>;
  };
  store: Pick<RuntimePluginApi['store'], 'get' | 'set' | 'delete'> & { keys(): Promise<string[]> };
  clock: RuntimePluginApi['clock'] & { now(): Promise<number> };
  command: { register(command: { name: string; description: string; immediate?: true }): Promise<{ command: string }> };
  tool: {
    register(spec: RuntimeToolSpec): Promise<{ tool: string }>;
    list(): Promise<readonly RuntimeToolInfo[]>;
    call(input: RuntimeToolCall): Promise<RuntimeToolResult>;
    check(input: RuntimeToolCall): Promise<RuntimeToolCheck>;
  };
  agent: {
    spawn(input: { prompt: string; model: string; description?: string; subagentType?: string; schema?: Record<string, unknown> }): Promise<{ id: string; agentId: string; model: string }>;
    list(): Promise<readonly RuntimeAgentInfo[]>;
    stop(input: { id: string }): Promise<void>;
    run(options: RuntimeAgentOptions): Promise<import('./runtime').RuntimeAgentResult>;
  };
  prompt: RuntimePluginApi['prompt'];
  fs: RuntimePluginApi['fs'];
  session: RuntimePluginApi['session'];
  env: RuntimePluginApi['env'];
  kimi: RuntimePluginApi;
}
export type ModsEvent = Record<string, unknown>;
export interface Origin { readonly plugin: string; readonly tier: 'prepend' | 'user' | 'append' | 'builtin' | 'core' }
export interface NextBudget { readonly ms: number; readonly remainingMs: number }
export interface HookBudget { readonly ms: 10000; readonly catchMs: 1000; readonly lingerMs: 5000 }
export type HookFailure = Readonly<{ kind: 'throw' | 'timeout' | 're-entry'; message?: string; budget: number; cause?: 'rewritten' | 'lent' }>;
export interface Caught { readonly error: HookFailure; readonly called: boolean }
export interface ModsNext {
  (event?: ModsEvent): Promise<unknown>;
  is(name: string, event: unknown): boolean;
  readonly signal: AbortSignal;
  readonly event: string;
  readonly origin: Origin;
  readonly budget: NextBudget;
}
export type ModsHandler = ($: EngineInterface, event: ModsEvent, next: ModsNext) => unknown;
export type CatchHandler<F = ModsHandler> = F extends ($: infer D, event: infer E, next: infer N) => infer R ? ($: D, event: E, next: N & Caught) => R | undefined | Promise<Awaited<R> | undefined> : never;
export interface Registration<F = ModsHandler> { catch(handler: CatchHandler<F>): void }
export interface On {
  (event: string, handler: ModsHandler): Registration;
  (event: string, matcher: Record<string, unknown>, handler: ModsHandler): Registration;
}

export type Register = (on: On, options: Record<string, unknown>) => unknown;
export type PluginOptions = Record<string, unknown>;
export type { InstructionFile } from '#/agent/profile/instructionFile';
export type { RuntimeFsAncestor as FsAncestor, RuntimeFsAncestorPart as FsAncestorPart, RuntimeFsAncestorsRequest as FsAncestorsRequest } from './runtime';
