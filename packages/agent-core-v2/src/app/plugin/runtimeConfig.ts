import { z } from 'zod';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const PLUGIN_RUNTIME_SETTINGS = 'pluginRuntime';
export const PluginRuntimeSettingsSchema = z.object({ options: z.record(z.string(), z.record(z.string(), z.unknown())).default({}) });
export type PluginRuntimeSettings = z.infer<typeof PluginRuntimeSettingsSchema>;

registerConfigSection(PLUGIN_RUNTIME_SETTINGS, PluginRuntimeSettingsSchema, { defaultValue: { options: {} }, fromToml: value => value });
