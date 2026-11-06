import { createDecorator } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { LlmRequest } from '#human/llm/request';
import type { LlmResolver, LlmResolveControl } from '#human/llm/policy/resolver';

export type AgentRequest = LlmRequest;
export type AgentRequestTransform = (request: AgentRequest, control: LlmResolveControl) => Promise<AgentRequest>;
export const IAgentRequestHooks = createDecorator<AgentRequestHooks>('agentRequestHooks');
export type IAgentRequestHooks = AgentRequestHooks;

export class AgentRequestHooks extends Disposable implements LlmResolver {
  declare readonly _serviceBrand: undefined;
  readonly id = 'agent-request-hooks';
  private readonly transforms = new Map<string, AgentRequestTransform>();
  register(id: string, transform: AgentRequestTransform): IDisposable {
    this.transforms.set(id, transform);
    return toDisposable(() => { if (this.transforms.get(id) === transform) this.transforms.delete(id); });
  }
  async resolve(request: LlmRequest, control: LlmResolveControl): Promise<LlmRequest> {
    for (const transform of this.transforms.values()) { control.signal.throwIfAborted(); request = await transform(request, control); }
    return request;
  }
  override dispose(): void { this.transforms.clear(); super.dispose(); }
}

registerScopedService(LifecycleScope.Agent, IAgentRequestHooks, AgentRequestHooks, ScopeActivation.OnScopeCreated, 'requestHooks');
