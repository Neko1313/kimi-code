import type {
  IAgentPermissionPolicyService,
  PermissionPolicyEvaluation,
} from '#/agent/permissionPolicy/permissionPolicy';

export function stubPermissionPolicyService(
  next: () => PermissionPolicyEvaluation | undefined,
): IAgentPermissionPolicyService {
  return {
    _serviceBrand: undefined,
    registerReviewer: () => ({ dispose() {} }),
    evaluate: () => Promise.resolve(next()),
  };
}
