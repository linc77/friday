import { acpRecord, type AcpRecord } from './acp-process.js';
import { acpNativePermission, type AcpNativePermission } from './acp-native.js';
// T3 8cd9641f AntigravityProtocol (MIT), copyright 2026 T3 Tools Inc.
// Full license: vendor/t3code/LICENSE.
const bounded = (value: string, limit: number) => limit <= 3 ? value.slice(0, Math.max(0, limit)) : value.length <= limit ? value : value.slice(0, limit - 3) + '...';
export function antigravityPermission(params: AcpRecord): AcpNativePermission {
  const options: AcpRecord[] = Array.isArray(params.options) ? params.options : [];
  if (typeof params.toolCall?.toolCallId === 'string' && params.toolCall.toolCallId.startsWith('interaction_')) {
    if (!options.length || options.some(value => typeof value.optionId !== 'string' || !value.optionId.trim()) || new Set(options.map(value => value.optionId)).size !== options.length) throw new Error('Antigravity 原生问题选项无效');
    const label = (value: AcpRecord) => bounded(typeof value.name === 'string' && value.name.trim() ? value.name.trim() : value.optionId, 512), id = params.toolCall.toolCallId;
    return { decisions: ['cancel', 'decline', 'accept'], questions: [{ id, header: 'Question', question: bounded(params.toolCall.title?.trim() || 'Choose an option.', 8000), multiSelect: false, isOther: false, options: options.map(value => ({ label: label(value), description: label(value), value: value.optionId })) }], respond: (decision, answers) => {
      if (decision !== 'accept') return { outcome: { outcome: 'cancelled' } };
      const values = answers[id]; if (!Array.isArray(values) || values.length !== 1) throw new Error('请选择一个 Antigravity 原生选项');
      const exact = options.find(value => value.optionId === values[0]), labels = options.filter(value => label(value) === values[0]), selected = exact ?? (labels.length === 1 ? labels[0] : undefined); if (!selected) throw new Error('Antigravity 问题选项已改变');
      return { outcome: { outcome: 'selected', optionId: selected.optionId } };
    } };
  }
  const result = acpNativePermission(params);
  return { ...result, options: result.decisions.map(decision => {
    const kind = decision === 'accept' ? 'allow_once' : decision === 'acceptForSession' ? 'allow_always' : 'reject_once', native = options.find(value => value.kind === kind), warning = acpRecord(native?._meta?.['agy.security.warning']), text = typeof warning?.message === 'string' && warning.message.trim() ? warning.message.trim() : typeof warning?.title === 'string' ? warning.title.trim() : '';
    return { decision, label: decision === 'accept' ? 'Approve' : decision === 'acceptForSession' ? 'Always allow this session' : decision === 'decline' ? 'Decline' : 'Cancel', ...(decision === 'acceptForSession' && text ? { warning: bounded(text, 512) } : {}) };
  }) };
}
export function normalizeAntigravityUpdate(change: AcpRecord): AcpRecord {
  if (!['tool_call', 'tool_call_update'].includes(change.sessionUpdate)) return change;
  const sanitize = (value: unknown, budget = { nodes: 512, text: 64000 }, depth = 0): unknown => {
    if (--budget.nodes < 0 || depth > 8) return undefined;
    if (typeof value === 'string') { const text = bounded(value, Math.min(8000, budget.text)); budget.text -= text.length; return text; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.slice(0, 512).flatMap(value => { const result = sanitize(value, budget, depth + 1); return result === undefined ? [] : [result]; });
    const record = acpRecord(value); if (record) return Object.fromEntries(Object.entries(record).slice(0, 512).flatMap(([name, value]) => { const result = sanitize(value, budget, depth + 1); return result === undefined ? [] : [[name, result]]; }));
  };
  const input = acpRecord(sanitize(change.rawInput)), output = acpRecord(sanitize(change.rawOutput)), command = input?.CommandLine ?? input?.command_line ?? input?.commandLine ?? input?.command ?? output?.commandLine ?? output?.command_line, text = output?.combinedOutput ?? output?.combined_output, exit = output?.exitCode ?? output?.exit_code;
  return { ...change, ...(typeof change.title === 'string' ? { title: bounded(change.title, 8000) } : {}), rawInput: { ...input, ...(typeof command === 'string' ? { command: command.trim() } : {}) }, rawOutput: { ...output, ...(typeof text === 'string' ? { type: 'text', text } : {}) }, content: sanitize(change.content, { nodes: 512, text: 32000 }), _meta: sanitize(change._meta), ...(!change.kind && command ? { kind: 'execute' } : {}), ...(Number.isSafeInteger(exit) ? { nativeExitCode: exit } : {}) };
}
