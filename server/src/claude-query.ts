import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConnection } from './claude-provider.js';
import type { WorkItem } from './types.js';

type Configuration = Awaited<ReturnType<ClaudeConnection['runtime']>>;
type LaunchConfiguration = Pick<Configuration, 'command' | 'env'>;

/** Keep executable selection, inherited environment and stderr handling identical
 * for capability probes, resident sessions and independent text generation. */
export function claudeQuery(configuration: LaunchConfiguration, prompt: AsyncIterable<SDKUserMessage>, options: Omit<Options, 'pathToClaudeCodeExecutable' | 'env' | 'stderr'>) {
  return query({ prompt, options: {
    ...options, pathToClaudeCodeExecutable: configuration.command, env: { ...process.env, ...configuration.env },
    // SDK results carry errors; raw stderr can contain private configuration.
    stderr: () => {},
  } });
}

/** Callers retain ownership of identity persistence, permissions and lifetime. */
export function claudeTaskOptions(configuration: Configuration, task: WorkItem, sessionId: string, instructions = ''): Options {
  return {
    cwd: task.cwd, model: configuration.apiModel, effort: configuration.apiEffort as Options['effort'], settings: configuration.modelSettings,
    ...(task.threadId ? { resume: sessionId, ...(task.claudeResumeSessionAt ? { resumeSessionAt: task.claudeResumeSessionAt } : {}) } : { sessionId }),
    includePartialMessages: true, permissionMode: configuration.permissionMode, settingSources: configuration.settingSources,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are Claude Code executing a specific local task delegated by Friday. Respond naturally in Chinese. Stay within the user request and selected workspace. Friday owns the main conversation. Do not commit, push, deploy, purchase, send messages, or spawn subagents unless explicitly requested. On continuation inspect current results before repeating any external action. Report concrete results and limitations.' + (instructions ? '\n\n' + instructions : '') },
  };
}
