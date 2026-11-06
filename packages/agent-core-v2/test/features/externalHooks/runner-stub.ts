import { Event } from '#/_base/event';
import type { ILogService } from '#/_base/log/log';
import { ExternalHooksRunnerService } from '#/features/externalHooks/app/externalHooksRunnerService';
import { HOOKS_SECTION } from '#/features/externalHooks/configSection';
import type { HookDef } from '#/features/externalHooks/internal/types';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginRuntimeHost } from '#/app/plugin/runtime';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

import { stubLog } from '../../_base/log/stubs';

export function stubRuntimeHost(
  overrides: Partial<IPluginRuntimeHost> = {},
): IPluginRuntimeHost {
  return {
    generation: 0,
    inheritContext: () => {},
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    runCore: work => work(),
    dispatch: async () => [],
    hasHandlers: () => false,
    summary: () => ({}),
    onDidChange: Event.None as IPluginRuntimeHost['onDidChange'],
    openSite: async () => undefined,
    renderSite: async () => undefined,
    dispatchSiteKey: async () => {},
    closePane: async () => {},
  listPanes: () => [],
    renderPane: async () => undefined,
    dispatchKey: async () => {},
    listTools: () => [],
    toolsFor: () => [],
    invoke: async (_event, input, _context, terminal) => terminal(input),
    getView: () => ({ revision: 0 }),
    listCommands: async () => [],
    runCommand: async () => undefined,
    call: async () => undefined,
    bindContext: () => ({ dispose() {} }),
    ...overrides,
  };
}

export function makeHookRunner(
  hooks: readonly HookDef[],
  options: {
    cwd?: string;
    log?: ILogService;
    telemetry?: ITelemetryService;
    runtime?: IPluginRuntimeHost;
    onTriggered?: (event: string, target: string, count: number) => void;
    onResolved?: (
      event: string,
      target: string,
      action: string,
      reason: string | undefined,
      durationMs: number,
    ) => void;
  } = {},
): ExternalHooksRunnerService {
  return new ExternalHooksRunnerService(
    {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (section: string) => (section === HOOKS_SECTION ? hooks : undefined),
    } as unknown as IConfigService,
    {
      _serviceBrand: undefined,
      enabledHooks: async () => [],
      onDidReload: Event.None as IPluginService['onDidReload'],
    } as unknown as IPluginService,
    {
      _serviceBrand: undefined,
      cwd: options.cwd ?? '',
      clientIdentity: { productName: 'test', version: '0.0.0-test', platform: 'test_platform' },
    } as unknown as IBootstrapService,
    new HostProcessService(),
    options.log ?? stubLog(),
    options.runtime ?? stubRuntimeHost(),
    options.telemetry ?? noopTelemetryService,
    { onTriggered: options.onTriggered, onResolved: options.onResolved },
  );
}
