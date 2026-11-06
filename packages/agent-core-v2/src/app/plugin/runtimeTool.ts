import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';

import { IAgentPluginRuntime } from './agentRuntime';
import picomatch from 'picomatch';

export const IPluginRuntimeTool = createDecorator<AgentTool>('pluginRuntimeTool');

export class PluginRuntimeTool implements AgentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Plugin';
  readonly description = 'Call a method provided by an enabled runtime plugin. Use a method name documented by its skill. Long operations return a background run id. Model aliases must be explicit for all workflow agents.';
  readonly parameters = {
    type: 'object', required: ['method', 'input'], additionalProperties: false,
    properties: { method: { type: 'string' }, input: {} },
  };

  constructor(@IAgentPluginRuntime private readonly runtime: IAgentPluginRuntime) {}

  resolveExecution(input: { method: string; input: unknown }): ToolExecution {
    return {
      approvalRule: `Plugin(${input.method})`, description: input.method,
      matchesRule: pattern => picomatch.isMatch(input.method, pattern),
      execute: async (ctx) => {
        try { return { output: JSON.stringify(await this.runtime.call(input, ctx.toolCallId)) ?? 'null' }; }
        catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) }; }
      },
    };
  }
}
