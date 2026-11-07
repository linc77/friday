import type { TaskPullRequest } from './types.js';
import type { ChangeRequestActivity, ChangeRequestDetail, ChangeRequestEffect, ChangeRequestReviewComment, ChangeRequestVerdict } from './task-change-request-data.js';
import type { ChangeRequestCommit } from './task-change-request-timeline.js';
import type { ChangeRequestThread } from './task-change-request-collaboration.js';
import type { ReviewReaction } from './task-change-request-review-state.js';
import type { AdditionalSourceControlKind } from './source-control-provider-identity.js';

export type AdditionalPullRequest = Omit<TaskPullRequest, 'provider'> & { provider: AdditionalSourceControlKind };
export type AdditionalChangeRequestDetail = Omit<ChangeRequestDetail, 'pullRequest'> & { pullRequest: AdditionalPullRequest; baseComparison?: 'unknown' | 'up-to-date' | 'behind'; providerVersion?: number };
export type AdditionalChangeRequestActivity = {
  items: ChangeRequestActivity[]; truncated: boolean; threads: ChangeRequestThread[];
  commits: ChangeRequestCommit[]; commitsTruncated: boolean;
  reactions: ReviewReaction[]; bySubject: Record<string, ReviewReaction[]>;
};
export type AdditionalChangeRequestInput = { action: string; body?: string; verdict?: ChangeRequestVerdict; comments?: ChangeRequestReviewComment[]; mergeMethod?: string; updateMethod?: string };
export type AdditionalChangeRequestEffects = ChangeRequestEffect[];
