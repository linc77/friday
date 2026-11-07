/** Provider-reported context occupancy, distinct from cumulative billing usage.
 * Semantics follow T3 8cd9641f CodexAdapterV2 / ClaudeAdapterV2. */
export type TaskContextUsage = {
  usedTokens: number; maxTokens: number | null; updatedAt: string; model?: string;
  inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number;
  promptCacheTtlMs?: number;
};
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
export function codexContextUsage(value: unknown, model?: string): TaskContextUsage | undefined {
  const report = record(value), last = record(report?.last), usedTokens = count(last?.totalTokens);
  if (usedTokens === undefined) return;
  const window = count(report?.modelContextWindow);
  const usage: TaskContextUsage = { usedTokens, maxTokens: window && window > 0 ? window : null, updatedAt: new Date().toISOString(), ...(model ? { model } : {}) };
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const) {
    const value = count(last?.[key]); if (value !== undefined) usage[key] = value;
  }
  return usage;
}
export function claudeContextUsage(value: unknown, model?: string, maxTokens?: unknown): TaskContextUsage | undefined {
  const report = record(value), input = count(report?.input_tokens), output = count(report?.output_tokens);
  if (input === undefined || output === undefined) return;
  const read = count(report?.cache_read_input_tokens) ?? 0, write = count(report?.cache_creation_input_tokens) ?? 0;
  const inputTokens = input + read + write, usedTokens = inputTokens + output, window = count(maxTokens);
  if (!Number.isFinite(usedTokens)) return;
  const creation = record(report?.cache_creation);
  const promptCacheTtlMs = (count(creation?.ephemeral_1h_input_tokens) ?? 0) > 0 ? 60 * 60_000
    : (count(creation?.ephemeral_5m_input_tokens) ?? 0) > 0 ? 5 * 60_000 : undefined;
  return { usedTokens, inputTokens, cachedInputTokens: read, outputTokens: output,
    ...(promptCacheTtlMs ? { promptCacheTtlMs } : {}),
    maxTokens: window && window > 0 ? window : null, updatedAt: new Date().toISOString(), ...(model ? { model } : {}) };
}
