import { acpRecord, type AcpRecord } from './acp-process.js';
import type { ApprovalDecision } from './provider-approvals.js';

// Pinned T3 Muse approval/question semantics; MIT, vendor/t3code/LICENSE.
export function museApprovalChoices(value: AcpRecord): Map<ApprovalDecision, AcpRecord> {
  const choices = new Map<ApprovalDecision, AcpRecord>();
  const rank = (choice: AcpRecord) => (choice.scope === 'once' ? 0 : choice.scope === 'session' ? 2 : 4) + (choice.decision.endsWith('PolicyAmendment') ? 1 : 0);
  for (const choice of Array.isArray(value.availableChoices) ? value.availableChoices : []) {
    if (typeof choice?.choiceId !== 'string' || typeof choice.decision !== 'string') continue;
    const decision: ApprovalDecision | undefined = choice.decision === 'approved' ? 'accept' : choice.decision === 'approvedForSession' ? 'acceptForSession'
      : choice.decision === 'approvedPolicyAmendment' ? choice.scope === 'session' ? 'acceptForSession' : choice.scope === 'localPersistent' ? 'acceptAlways' : undefined
      : ['denied', 'deniedPolicyAmendment'].includes(choice.decision) ? 'decline' : choice.decision === 'abort' ? 'cancel' : undefined;
    if (decision && (!choices.has(decision) || rank(choice) < rank(choices.get(decision)!))) choices.set(decision, choice);
  }
  if (!choices.has('decline') && choices.has('cancel')) choices.set('decline', choices.get('cancel')!);
  return choices;
}
export function museQuestionAnswers(questions: AcpRecord[], answers: Record<string, string[]>) {
  return questions.map(question => {
    const raw = answers[question.id]; if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string')) throw new Error('Muse 回答格式无效');
    const values = [...new Set(raw)], selected = values.filter(value => question.options.some((option: AcpRecord) => option.label === value)), freeText = values.filter(value => !selected.includes(value)).join('\n'), selection = acpRecord(question.selection);
    if ((!freeText && !selected.length) || freeText.length > 500 || selection?.mode === 'single' && selected.length > 1 || selected.length && (selected.length < (selection?.minSelections ?? 0) || selected.length > (selection?.maxSelections ?? Infinity))) throw new Error('Muse 回答的选项数量或补充文字无效');
    return { questionId: question.id, ...(selected.length ? selection?.mode === 'single' ? { selectedLabel: selected[0] } : { selectedLabels: selected } : {}), ...(freeText ? selected.length ? { note: freeText } : { freeText } : {}) };
  });
}
