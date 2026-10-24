export type GrokSubagentTool = { toolCallId: string; title?: string; status?: string; data: Record<string, unknown> };
export function extractXAiAcpSubagentUpdate(tool: GrokSubagentTool): {
  nativeTaskId: string; prompt: string; title: string | null; model: string | null;
  status: 'running' | 'completed' | 'failed'; childSessionId: string | null; result: string | null; suppressNormalTool: boolean;
} | undefined;
export function extractXAiAcpSubagentEndNotice(text: string): { childSessionId: string; status: 'completed' | 'failed' } | undefined;
