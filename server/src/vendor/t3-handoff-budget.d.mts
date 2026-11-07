export type HistoricalMessage = { role: 'user' | 'assistant'; text: string; threadId: string; runId: string | null; itemId: string; providerThreadId: string | null; status: string; kind: string; runStatus?: string };
export function renderHistory(messages: readonly HistoricalMessage[], context: string): string;
export function historyResponseItems(messages: readonly HistoricalMessage[], context: string): unknown[];
export function historyCost(messages: readonly HistoricalMessage[], context: string): number;
export function selectHistory(input: { messages: readonly HistoricalMessage[]; coverage: string; omittedItems?: number; budget: number }): { messages: HistoricalMessage[]; omittedItemIds: string[]; context: string; omittedItems: number };
