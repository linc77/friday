import type { TaskPullRequest, TaskWorkspacePlan } from './types.js';
import type { SourceControlRepository } from './task-change-requests.js';

export type ChangeRequestCheckoutPreview = {
  pullRequest: TaskPullRequest; headSha: string; headRepository: SourceControlRepository | null;
  localBranch: string; worktreeBranch: string; fingerprint: string; localFingerprint: string; dirty: boolean;
};
export type ChangeRequestCheckout = {
  id: string; projectId: string; requestId: string; digest: string; durableId: number;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'interrupted'; mode: 'checkout' | 'worktree';
  pullRequest: TaskPullRequest; headSha: string; common: string; sourcePath: string; root: string; branch: string;
  setupRunId?: string;
  setupWarning?: string;
  createdAt: string; updatedAt: string; plan?: TaskWorkspacePlan; reused?: boolean; isOnHead?: boolean; moved?: boolean; error?: string;
};
