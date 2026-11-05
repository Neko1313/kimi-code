import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { HookResult } from '#/features/externalHooks/internal/types';

export const RUNTIME_CAPABILITIES = ['events', 'log', 'store', 'clock'] as const;

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
}

export type RuntimeHandler = (
  api: RuntimePluginApi,
  event: RuntimeEventPayload,
  next: RuntimeNext,
) => unknown;

export interface RuntimeBlock {
  readonly block: string;
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
