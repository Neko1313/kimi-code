import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { HookResult } from '#/features/externalHooks/internal/types';

export const RUNTIME_CAPABILITIES = ['events', 'log', 'store', 'clock', 'process', 'ui'] as const;

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export interface PluginRuntimeConfig {
  readonly modules: readonly string[];
  readonly capabilities: readonly RuntimeCapability[];
}

export interface RuntimeEventPayload {
  readonly event: string;
  readonly sessionId?: string;
  readonly cwd: string;
  readonly data: Record<string, unknown>;
}

export type RuntimeNext = (
  event?: RuntimeEventPayload,
) => RuntimeEventPayload | undefined | Promise<RuntimeEventPayload | undefined>;

export interface RuntimePluginApi {
  readonly pluginId: string;
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
  };
  readonly store: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  readonly clock: {
    every(ms: number, fn: () => void): { cancel(): void };
    after(ms: number, fn: () => void): { cancel(): void };
  };
  readonly process: {
    run(
      args: readonly string[],
      options?: { timeoutMs?: number; cwd?: string; input?: string },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  readonly ui: {
    open(options: { id: string; title: string }): Promise<void>;
    close(options: { id: string }): Promise<void>;
    invalidate(): void;
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
      readonly children: readonly (RuntimeElement | string)[];
    }
  | { readonly type: 'text'; readonly text: string; readonly color?: RuntimeUiColor }
  | { readonly type: 'button'; readonly label: string; readonly hotkey?: string };

export interface PluginPaneInfo {
  readonly id: string;
  readonly title: string;
}

export interface PluginUiHost {
  listPanes(): readonly PluginPaneInfo[];
  renderPane(id: string, width: number): Promise<RuntimeElement | undefined>;
  dispatchKey(id: string, key: string): Promise<void>;
  onDidChange(listener: () => void): () => void;
}

const PLUGIN_UI_HOST_KEY = Symbol.for('kimi-code.pluginUiHost');

export function registerPluginUiHost(host: PluginUiHost): void {
  (globalThis as Record<symbol, unknown>)[PLUGIN_UI_HOST_KEY] = host;
}

export function getPluginUiHost(): PluginUiHost | undefined {
  return (globalThis as Record<symbol, unknown>)[PLUGIN_UI_HOST_KEY] as PluginUiHost | undefined;
}

export type RuntimeModule = {
  register(on: RuntimeRegistrar): void | Promise<void>;
};

export interface RuntimeRegistrar {
  (event: string, handler: RuntimeHandler): void;
  (event: string, matcher: string, handler: RuntimeHandler): void;
}

export interface IPluginRuntimeHost {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  dispatch(event: string, args: RuntimeDispatchArgs): Promise<HookResult[]>;
  hasHandlers(event: string): boolean;
  summary(): Record<string, number>;
}

export interface RuntimeDispatchArgs {
  readonly matcherValue?: string;
  readonly sessionId?: string;
  readonly cwd: string;
  readonly data?: Record<string, unknown>;
}

export const IPluginRuntimeHost: ServiceIdentifier<IPluginRuntimeHost> =
  createDecorator<IPluginRuntimeHost>('pluginRuntimeHost');
