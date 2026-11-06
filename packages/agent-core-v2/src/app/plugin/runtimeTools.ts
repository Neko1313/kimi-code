import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { IAgentLoopService } from '#/agent/loop/loop';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ProfileBind } from '#/agent/profile/profileOps';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { compileToolArgsValidator, validateToolArgs, type JsonType } from '#/tool/args-validator';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import picomatch from 'picomatch';

import { IAgentPluginRuntime } from './agentRuntime';
import { IPluginRuntimeHost, type RuntimePublishedTool } from './runtime';

export const IRuntimePluginTools = createDecorator<RuntimePluginTools>('runtimePluginTools');

export class RuntimePluginTools extends Service {
  private readonly registrations = new Map<string, { definition: RuntimePublishedTool; registration: IDisposable }>();
  private ready = false;
  private disposed = false;

  constructor(
    @IPluginRuntimeHost private readonly host: IPluginRuntimeHost,
    @IAgentPluginRuntime private readonly runtime: IAgentPluginRuntime,
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IEventBus bus: IEventBus,
    @ILogService private readonly log: ILogService,
    @IAgentToolPolicyService private readonly policy: IAgentToolPolicyService,
    @IAgentLoopService loop: IAgentLoopService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
  ) {
    super();
    this._register(loop.hooks.onWillBeginStep.register('plugin-tools', async (_ctx, next) => {
      await host.ready; this.ready = true; this.sync(); await next();
    }));
    this._register(host.onDidChange(() => this.sync()));
    this._register(bus.subscribe(ProfileBind, () => { queueMicrotask(() => this.sync()); }));
    this._register(bus.subscribe(AgentStatusUpdated, () => this.sync()));
    void host.ready.then(() => { this.ready = true; this.sync(); }).catch((error: unknown) => this.log.warn('Plugin tools could not load', { error }));
  }

  private sync(): void {
    if (!this.ready || this.disposed) return;
    const definitions = this.host.toolsFor({ sessionId: this.session.sessionId, agentId: this.scope.agentId, cwd: this.session.cwd });
    const allowed = this.profile.getActiveToolNames();
    const canCallPlugins = (allowed === undefined || allowed.includes('Plugin')) && this.policy.isToolActive('Plugin');
    for (const [name, current] of this.registrations) {
      if (!canCallPlugins || !definitions.includes(current.definition)) {
        current.registration.dispose();
        this.profile.removeActiveTool(name);
        this.registrations.delete(name);
      }
    }
    if (!canCallPlugins) return;
    for (const definition of definitions) {
      if (!this.registrations.has(definition.name)) {
        if (this.registry.resolve(definition.name) !== undefined) {
          this.log.warn(`Plugin tool conflicts with an existing tool: ${definition.name}`);
          continue;
        }
        const validator = compileToolArgsValidator(definition.inputSchema);
        const registration = this.registry.register({
          name: definition.name, description: definition.description, parameters: definition.inputSchema,
          resolveExecution: input => {
            const issue = validateToolArgs(validator, input as JsonType);
            if (issue !== null) return { isError: true, output: `Invalid input for ${definition.name}: ${issue}` };
            return {
              approvalRule: `Plugin(${definition.method})`, description: definition.description,
              permissionToolName: 'Plugin', matchesRule: pattern => picomatch.isMatch(definition.method, pattern),
              execute: async (ctx) => {
                try {
                  if (!this.policy.isToolActive('Plugin')) throw new Error('Plugin tools are disabled by the active tool policy');
                  return { output: JSON.stringify(await this.runtime.call({ method: definition.method, input }, ctx.toolCallId)) ?? 'null' };
                } catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) }; }
              },
            };
          },
        }, { source: 'user', disclosure: definition.isDeferred ? 'deferred' : 'inline' });
        this.registrations.set(definition.name, { definition, registration });
      }
      this.profile.addActiveTool(definition.name);
    }
  }

  override dispose(): void {
    this.disposed = true;
    for (const [name, current] of this.registrations) {
      current.registration.dispose();
      this.profile.removeActiveTool(name);
    }
    this.registrations.clear();
    super.dispose();
  }
}
