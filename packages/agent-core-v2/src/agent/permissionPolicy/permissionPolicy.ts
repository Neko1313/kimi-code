import { createDecorator } from "#/_base/di/instantiation";
import type {
  ResolvedToolExecutionHookContext
} from '#/agent/toolExecutor/toolHooks';
import type { PermissionPolicyResult } from './types';


export interface PermissionPolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export interface IAgentPermissionPolicyService {
  readonly _serviceBrand: undefined;

  evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined>;
  registerReviewer(reviewer: (context: ResolvedToolExecutionHookContext, evaluation: PermissionPolicyEvaluation) => Promise<PermissionPolicyEvaluation>): import('#/_base/di/lifecycle').IDisposable;
}

export const IAgentPermissionPolicyService =
  createDecorator<IAgentPermissionPolicyService>('agentPermissionPolicyService');
