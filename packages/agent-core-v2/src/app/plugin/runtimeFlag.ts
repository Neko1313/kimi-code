import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const PLUGIN_RUNTIME_FLAG_ID = 'plugin_runtime';
export const PLUGIN_RUNTIME_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_PLUGIN_RUNTIME';

export const pluginRuntimeFlag: FlagDefinitionInput = {
  id: PLUGIN_RUNTIME_FLAG_ID,
  title: 'In-process plugin runtime',
  description:
    'Let enabled plugins load runtime modules (JavaScript or TypeScript) that handle engine events in-process and expose a capability-gated host API.',
  env: PLUGIN_RUNTIME_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(pluginRuntimeFlag);
