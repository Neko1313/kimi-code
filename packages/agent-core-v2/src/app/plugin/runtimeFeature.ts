import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { AgentPluginRuntime, IAgentPluginRuntime } from './agentRuntime';
import { IPluginRuntimeHost } from './runtime';
import { PluginRuntimeHost } from './runtimeHost';
import { PLUGIN_RUNTIME_FLAG_ID } from './runtimeFlag';
import { IRuntimePluginTools, RuntimePluginTools } from './runtimeTools';
import { IPluginRuntimeTool, PluginRuntimeTool } from './runtimeTool';

export class PluginRuntimeFeature extends Feature {
  static override readonly name = 'pluginRuntime';

  constructor() {
    super();
    this.contributeService(LifecycleScope.App, IPluginRuntimeHost, PluginRuntimeHost);
    this.contributeAgentService(IAgentPluginRuntime, AgentPluginRuntime);
    this.contributeAgentService(IRuntimePluginTools, RuntimePluginTools);
    this.contributeTool(IPluginRuntimeTool, PluginRuntimeTool, {
      name: 'Plugin', domain: 'pluginRuntime', when: (accessor) => accessor.get(IFlagService).enabled(PLUGIN_RUNTIME_FLAG_ID),
    });
  }
}

registerFeature(PluginRuntimeFeature);
