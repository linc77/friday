// Older clients and saved pending turns may still request the removed mode.
// Reject those requests instead of silently giving read-only work write access.
export function assertCurrentTaskMode(input: object) {
  const legacy = input as { interactionMode?: unknown; text?: unknown; prompt?: unknown };
  const text = legacy.text ?? legacy.prompt;
  if (legacy.interactionMode !== undefined && legacy.interactionMode !== 'default'
      || typeof text === 'string' && /^\s*\/(?:plan|default)(?:\s|$)/i.test(text)) {
    throw new Error('计划模式已移除，请重新发送普通任务要求');
  }
}
