import type { Workspace } from './types.js';
/** Legacy snapshots and overview streams share the same private-state boundary. */
export function publicProviderState(state: Workspace): Workspace {
  const { approvalResponses: _approvals, providerCreditAccounts: _accounts, providerCreditResets: _resets, taskFeedbackRequests: _feedback, usageSourceResetRequests: _sourceResets, usageSourceResetTail: _sourceTail, providerUsageIdentities: _identities, projectScriptSettles: _scriptSettles, ...visible } = state;
  return visible;
}
