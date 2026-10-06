import { defineDoc } from '@earendil-works/pi-durable';
import type { Workspace } from './types.js';

export const WorkspaceDoc = defineDoc<Workspace>({
  kind: 'friday.workspace', version: 1, scope: 'session',
  initial: () => ({ revision: 0, ideas: [], projects: [], memories: [], tasks: [], requests: {}, queueTail: null }),
});
