export type TaskStatus = 'queued' | 'running' | 'waiting' | 'needs_project' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type IdeaImage = { id: string; name: string; mediaType: string };
export type Idea = { id: string; text: string; createdAt: string; taskId: string | null; title?: string; updatedAt?: string; images?: IdeaImage[]; lastEditId?: string };
export type Project = { id: string; name: string; path: string; context: string };
export type Memory = { id: string; text: string; updatedAt: string };
export type Question = { id: string; header: string; question: string; options: { label: string; description: string }[] };
export type Approval = { id: string; method: string; title: string; detail: string; questions: Question[]; state: 'pending' | 'answered' | 'expired'; decision?: 'accept' | 'decline'; answers?: Record<string, string[]> };
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; at?: string; turnId?: string };
export type TaskMode = 'auto' | 'assistant' | 'research' | 'code';
export type TaskEvent = {
  id: string; kind: string; text: string; at: string;
  itemId?: string; turnId?: string; phase?: 'commentary' | 'final_answer';
  status?: 'running' | 'completed' | 'failed' | 'declined' | 'interrupted';
  detail?: string; completedAt?: string; durationMs?: number; exitCode?: number;
};
export type WorkItem = {
  id: string; title: string; prompt: string; projectId: string | null; cwd: string;
  agent: string; mode: TaskMode; status: TaskStatus; createdAt: string; updatedAt: string;
  durableId: number | null; threadId: string | null; turnId: string | null;
  result: string; error: string | null; events: TaskEvent[]; approvals: Approval[];
  conversationId?: number; messages?: ChatMessage[];
  codexHome?: string;
  claudeHome?: string;
  parentId?: string; model?: string; reasoningEffort?: string;
  artifact: string | null; lastRequestId: string;
  workspaceRequest?: string | null;
};
export type Workspace = {
  revision: number; ideas: Idea[]; projects: Project[]; memories: Memory[];
  tasks: WorkItem[]; requests: Record<string, string>; queueTail?: number | null; assistantQueueTail?: number | null;
};
export type AgentInfo = { id: string; name: string; installed: boolean; executable: string | null; executableSupported: boolean; description: string };
export type ExecutionUpdate =
  | { kind: 'session'; threadId: string; codexHome?: string; claudeHome?: string; model?: string; reasoningEffort?: string }
  | { kind: 'turn'; turnId: string }
  | { kind: 'output'; text: string }
  | { kind: 'event'; eventKind: string; text: string }
  | { kind: 'item'; item: TaskEvent }
  | { kind: 'approval'; approval: Approval }
  | { kind: 'approvalResolved'; id: string }
  | { kind: 'workspace'; reason: string }
  | { kind: 'idea'; id: string; text: string }
  | { kind: 'memory'; id: string; text: string }
  | { kind: 'note'; id: string; title: string; content: string };
export type ExecutionRequest = { task: WorkItem; prompt: string; signal: AbortSignal; update: (update: ExecutionUpdate) => Promise<void> };
export interface Executor {
  run(request: ExecutionRequest): Promise<string>;
  answer(taskId: string, approvalId: string, decision: 'accept' | 'decline', answers: Record<string, string[]>): Promise<void>;
  steer(taskId: string, text: string, requestId: string): Promise<void>;
}
export const activeStatuses: TaskStatus[] = ['queued', 'running', 'waiting'];
