export type GrokSubagentTool = { toolCallId: string; title?: string; status?: string; data: Record<string, unknown> };
export function extractXAiAcpSubagentUpdate(tool: GrokSubagentTool): {
  nativeTaskId: string; prompt: string; title: string | null; model: string | null;
  status: 'running' | 'completed' | 'failed'; childSessionId: string | null; result: string | null; suppressNormalTool: boolean;
} | undefined;
export function extractXAiAcpSubagentEndNotice(text: string): { childSessionId: string; status: 'completed' | 'failed' } | undefined;
export function isXAiTaskCompletedWakeNotification(value: Record<string, any>): boolean;
export function extractXAiMonitorTaskId(tool: GrokSubagentTool): string | undefined;
export function isXAiPersistentMonitor(tool: GrokSubagentTool): boolean;
export type GrokBackgroundMutation = { taskId: string; status: 'running' | 'completed' | 'failed'; appendOutput: string };
export function extractXAiBackgroundTaskCompletion(tool: GrokSubagentTool): GrokBackgroundMutation[];
export function extractXAiKilledBackgroundTasks(tool: GrokSubagentTool): GrokBackgroundMutation[];
export function extractXAiAcpBackgroundToolMutation(text: string): GrokBackgroundMutation[];
export function xAiBackgroundTaskLifecycleMutation(value: Record<string, any>, status: 'running' | 'completed'): { sessionId: string; taskId: string; status: 'running' | 'completed' | 'failed'; output?: string; report?: { kind: 'command' | 'monitor'; label?: string; exitCode?: number } } | null;
