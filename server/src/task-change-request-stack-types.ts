export type ChangeRequestStack = {
  id: string; number: number; url: string; base: string;
  layers: { number: number; title?: string; isDraft?: boolean; headSha?: string; headBranch: string; state: 'open' | 'closed' | 'merged' }[];
};
// Saved navigation never supplies action head SHAs.
export type SavedChangeRequestStack = Omit<ChangeRequestStack, 'layers'> & { layers: Omit<ChangeRequestStack['layers'][number], 'headSha'>[]; syncedAt: string };
export type StackActionSubmission = {
  requestId: string; url: string; action: 'merge' | 'update-branch'; stackNumber: number; targetNumber: number;
  expectedStackHeads: { number: number; headSha: string }[]; mergeMethod?: string; updateMethod?: 'rebase';
};
