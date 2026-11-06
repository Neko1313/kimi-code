import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { runtimeCommandSchema } from '../global/plugins.js';
export { runtimeCommandSchema } from '../global/plugins.js';

export type PluginElement =
  | { type: 'box'; direction: 'row' | 'column'; gap?: number; captureEscape?: boolean; children: (PluginElement | string)[] }
  | { type: 'text'; text: string; color?: 'primary' | 'success' | 'error' | 'warning' | 'dim' | 'muted' | 'textStrong'; key?: string; selected?: boolean }
  | { type: 'button'; label: string; hotkey?: string; action?: string }
  | ModsElement;


export type ModsElement = {
  type: 'Box' | 'Text' | 'Button' | 'Select' | 'Input' | 'Markdown' | 'Code' | 'Link' | 'Svg';
  props?: Record<string, unknown>;
  children?: (ModsElement | string)[];
};
const modsElementSchema: z.ZodType<ModsElement> = z.lazy(() => z.object({
  type: z.enum(['Box', 'Text', 'Button', 'Select', 'Input', 'Markdown', 'Code', 'Link', 'Svg']),
  props: z.record(z.string(), z.unknown()).optional(), children: z.array(z.union([z.string(), modsElementSchema])).optional(),
}));

export const pluginElementSchema: z.ZodType<PluginElement> = z.lazy(() => z.union([
  z.object({ type: z.literal('box'), direction: z.enum(['row', 'column']), gap: z.number().optional(), captureEscape: z.boolean().optional(), children: z.array(z.union([z.string(), pluginElementSchema])) }),
  z.object({ type: z.literal('text'), text: z.string(), color: z.enum(['primary', 'success', 'error', 'warning', 'dim', 'muted', 'textStrong']).optional(), key: z.string().optional(), selected: z.boolean().optional() }),
  z.object({ type: z.literal('button'), label: z.string(), hotkey: z.string().optional(), action: z.string().optional() }),
  modsElementSchema,
]));

export const pluginPaneSchema = z.object({ id: z.string(), title: z.string(), pluginId: z.string(), closeOnEscape: z.boolean().optional(), columns: z.number().optional(), rows: z.number().optional() });
export const pluginRuntimeContract = {
  renderSite: { input: z.tuple([z.object({ component: z.string().min(1).max(128), requestId: z.string().min(1).max(256).optional(), surface: z.enum(['terminal', 'desktop', 'mobile', 'vscode']).optional(), width: z.number().int().min(1).max(10000), rows: z.number().int().min(1).max(10000), props: z.record(z.string(), z.unknown()).optional(), clientId: z.string().optional(), defaultTree: pluginElementSchema.optional() })]), output: maybe(pluginElementSchema) },
  dispatchSiteKey: { input: z.tuple([z.object({ component: z.string().min(1).max(128), requestId: z.string().min(1).max(256).optional(), key: z.string().max(8192), clientId: z.string().optional() })]), output: noResult },
  getView: { input: z.tuple([z.object({ clientId: z.string().optional() })]), output: z.object({ agentId: z.string().optional(), paneId: z.string().optional(), revision: z.number().int().nonnegative() }) },
  openSite: { input: z.tuple([z.object({ component: z.string().min(1).max(128), surface: z.enum(['terminal', 'desktop', 'mobile', 'vscode']).optional(), props: z.record(z.string(), z.unknown()).optional() })]), output: maybe(z.string()) },
  closePane: { input: z.tuple([z.object({id:z.string().min(1)})]), output: noResult },
  listPanes: { input: z.tuple([]), output: z.array(pluginPaneSchema) },
  renderPane: { input: z.tuple([z.object({ id: z.string().min(1), width: z.number().int().min(1).max(10000), rows: z.number().int().min(1).max(10000).optional(), surface: z.enum(['terminal', 'desktop', 'mobile', 'vscode']).optional(), placement: z.enum(['dock', 'inline']).optional(), clientId: z.string().optional() })]), output: maybe(pluginElementSchema) },
  dispatchKey: { input: z.tuple([z.object({ id: z.string().min(1), key: z.string().max(4096), clientId: z.string().optional() })]), output: noResult },
  listCommands: { input: z.tuple([]), output: z.array(runtimeCommandSchema) },
  runCommand: { input: z.tuple([z.object({ name: z.string().min(1), args: z.string().optional() })]), output: z.unknown() },
  call: { input: z.tuple([z.object({ method: z.string().min(1), input: z.unknown() })]), output: z.unknown() },
} satisfies ServiceContract;
