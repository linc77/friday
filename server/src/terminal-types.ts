export type TaskTerminalSummary = {
  id: string; taskId: string; generation: number; cwd: string; shell: string; label: string; title: string;
  status: 'starting' | 'running' | 'closing' | 'exited' | 'closed' | 'interrupted' | 'error';
  pid: number | null; cols: number; rows: number; sequence: number; baseSequence: number;
  hasRunningSubprocess: boolean; createdAt: string; updatedAt: string; exitCode?: number; exitSignal?: number; error?: string; historyTruncated?: boolean;
};
export type TerminalEvent =
  | { type: 'snapshot'; terminal: TaskTerminalSummary; history: string; sequence: number; generation: number; truncated: boolean }
  | { type: 'output'; data: string; sequence: number; generation: number }
  | { type: 'metadata'; terminal: TaskTerminalSummary; sequence: number; generation: number }
  | { type: 'clear'; sequence: number; generation: number }
  | { type: 'closed'; sequence: number; generation: number };
export type TerminalOperation = { taskId: string; terminalId: string; requestId: string; action: 'open' | 'restart' | 'close'; generation: number; bootId: string; force: boolean; deleteHistory: boolean; scriptRunId?: string };
export type TerminalReceipt = { requestId: string; taskId: string; terminalId: string; generation: number; digest: string; state: 'started' | 'sent' | 'uncertain' };
export const terminalID = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('终端 ID 无效'); return value;
};
export const terminalRequestID = (value: unknown) => {
  if (typeof value !== 'string' || !value || value.length > 100 || /[\x00-\x1f]/.test(value)) throw new Error('终端请求 ID 无效'); return value;
};
export const terminalSize = (cols: unknown = 120, rows: unknown = 30) => {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 1 || Number(cols) > 1000 || Number(rows) < 1 || Number(rows) > 500) throw new Error('终端尺寸无效');
  return { cols: Number(cols), rows: Number(rows) };
};
