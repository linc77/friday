import type { Engine } from './engine.js';
import type { Workspace } from './types.js';
import { loadCodexSettings } from './codex-settings.js';
import { loadClaudeSettings } from './claude-provider.js';

export type TextGenerationModelSelection = { agent: 'codex' | 'claude'; model: string; reasoningEffort: string };
export type SourceControlWritingStyle = { mode: 'repo_conventions' | 'conventional_commits' | 'custom'; customInstructions: string; followChangeRequestTemplates: boolean };
export const defaultSourceControlWritingStyle = (): SourceControlWritingStyle => ({ mode: 'repo_conventions', customInstructions: '', followChangeRequestTemplates: true });
export type TextGenerationScope = { textGenerationModelSelection?: TextGenerationModelSelection; sourceControlWriterModelSelection?: TextGenerationModelSelection | null; sourceControlWritingStyle?: SourceControlWritingStyle; reviewGuidesEnabled?: boolean; reviewGuideModelSelection?: TextGenerationModelSelection | null; reviewGuideInstructions?: string };
type TextGenerationChanges = Omit<TextGenerationScope, 'sourceControlWritingStyle'> & { sourceControlWritingStyle?: Partial<SourceControlWritingStyle> };
export type TextGenerationSettings = { version: number; defaults: Required<Omit<TextGenerationScope, 'reviewGuidesEnabled' | 'reviewGuideModelSelection' | 'reviewGuideInstructions'>> & Pick<TextGenerationScope, 'reviewGuidesEnabled' | 'reviewGuideModelSelection' | 'reviewGuideInstructions'>; projects: Record<string, TextGenerationScope> };
export type TextGenerationSettingKey = keyof TextGenerationScope;
type Source = 'default' | 'host' | 'workspace' | 'fallback' | 'text_generation' | 'source_control';
export type TextGenerationSettingsSnapshot = {
  version: number; projectId: string | null; defaults: Required<TextGenerationScope>; overrides: TextGenerationScope;
  effective: { textGenerationModelSelection: TextGenerationModelSelection; sourceControlWriterModelSelection: TextGenerationModelSelection; sourceControlWritingStyle: SourceControlWritingStyle; reviewGuidesEnabled: boolean; reviewGuideModelSelection: TextGenerationModelSelection; reviewGuideInstructions: string };
  sources: Record<TextGenerationSettingKey, Source>; enabled: Record<'codex' | 'claude', boolean>;
};
export const defaultTextGenerationModel = (): TextGenerationModelSelection => ({ agent: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low' });
const defaultFor = (agent: TextGenerationModelSelection['agent']): TextGenerationModelSelection => agent === 'codex' ? { ...defaultTextGenerationModel(), reasoningEffort: '' } : { agent, model: 'claude-haiku-5-5', reasoningEffort: '' };
export const textGenerationDefaults = (): TextGenerationSettings => ({ version: 0, defaults: { textGenerationModelSelection: defaultTextGenerationModel(), sourceControlWriterModelSelection: null, sourceControlWritingStyle: defaultSourceControlWritingStyle(), reviewGuidesEnabled: false, reviewGuideModelSelection: null, reviewGuideInstructions: '' }, projects: {} });
const keys: TextGenerationSettingKey[] = ['textGenerationModelSelection', 'sourceControlWriterModelSelection', 'sourceControlWritingStyle', 'reviewGuidesEnabled', 'reviewGuideModelSelection', 'reviewGuideInstructions'];
const reserved = ['__proto__', 'constructor', 'prototype'];
export class TextGenerationSettingsConflict extends Error { constructor(readonly version: number) { super('文字生成设置已在其他设备修改，请重新加载后再修改。'); } }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文字生成设置格式无效');
  return value as Record<string, unknown>;
}
function selection(value: unknown): TextGenerationModelSelection {
  const data = object(value);
  if (Object.keys(data).some(key => !['agent', 'model', 'reasoningEffort'].includes(key)) || !['codex', 'claude'].includes(String(data.agent))) throw new Error('文字生成 Provider 无效');
  if (typeof data.model !== 'string' || !data.model.trim() || data.model.length > 160 || /[\x00-\x1f\x7f]/.test(data.model)) throw new Error('文字生成模型无效');
  if (typeof data.reasoningEffort !== 'string' || data.reasoningEffort.length > 30 || /[\x00-\x1f\x7f]/.test(data.reasoningEffort)) throw new Error('文字生成推理强度无效');
  return { agent: data.agent as TextGenerationModelSelection['agent'], model: data.model.trim(), reasoningEffort: data.reasoningEffort.trim() };
}
export function textGenerationSettingsChange(value: unknown) {
  const body = object(value);
  if (Object.keys(body).some(key => !['projectId', 'expectedVersion', 'changes', 'reset'].includes(key))) throw new Error('文字生成设置包含不支持的字段');
  if (body.projectId !== null && (typeof body.projectId !== 'string' || !body.projectId || body.projectId.length > 100 || reserved.includes(body.projectId))) throw new Error('Workspace ID 无效');
  if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new Error('文字生成设置版本无效');
  const changes: TextGenerationChanges = {}; const source = body.changes === undefined ? {} : object(body.changes);
  for (const key of Object.keys(source)) {
    if (!keys.includes(key as TextGenerationSettingKey)) throw new Error('文字生成设置包含不支持的字段');
    if (key === 'reviewGuidesEnabled') { if (body.projectId !== null || typeof source[key] !== 'boolean') throw new Error('Guide 开关只能在主机范围设置'); changes.reviewGuidesEnabled = source[key] as boolean; }
    else if (key === 'reviewGuideInstructions') { if (typeof source[key] !== 'string' || (source[key] as string).length > 16000 || (source[key] as string).includes('\0')) throw new Error('Guide 自定义说明无效'); changes.reviewGuideInstructions = (source[key] as string).trim(); }
    else if (key === 'reviewGuideModelSelection') changes.reviewGuideModelSelection = source[key] === null ? null : selection(source[key]);
    else if (key === 'sourceControlWritingStyle') {
      const style = object(source[key]);
      if (!Object.keys(style).length || Object.keys(style).some(field => !['mode', 'customInstructions', 'followChangeRequestTemplates'].includes(field))) throw new Error('Source Control 写作设置包含不支持的字段');
      if (Object.hasOwn(style, 'mode') && (typeof style.mode !== 'string' || !['repo_conventions', 'conventional_commits', 'custom'].includes(style.mode))) throw new Error('Source Control 写作风格无效');
      if (Object.hasOwn(style, 'customInstructions')) {
        if (typeof style.customInstructions !== 'string' || style.customInstructions.includes('\0')) throw new Error('Source Control 自定义说明无效');
        try { encodeURIComponent(style.customInstructions); } catch { throw new Error('Source Control 自定义说明无效'); }
      }
      if (Object.hasOwn(style, 'followChangeRequestTemplates') && typeof style.followChangeRequestTemplates !== 'boolean') throw new Error('PR 模板设置无效');
      changes.sourceControlWritingStyle = { ...style, ...(typeof style.customInstructions === 'string' ? { customInstructions: style.customInstructions.trim() } : {}) };
    } else if (key === 'sourceControlWriterModelSelection') changes[key] = source[key] === null ? null : selection(source[key]);
    else changes.textGenerationModelSelection = selection(source[key]);
  }
  const reset = body.reset ?? [];
  if (body.projectId !== null && Array.isArray(reset) && reset.includes('reviewGuidesEnabled')) throw new Error('Guide 开关只能在主机范围设置');
  if (!Array.isArray(reset) || reset.some(key => !keys.includes(key) || Object.hasOwn(changes, key)) || new Set(reset).size !== reset.length) throw new Error('文字生成设置重置范围无效');
  if (!Object.keys(changes).length && !reset.length) throw new Error('没有需要保存的文字生成设置');
  return { projectId: body.projectId as string | null, expectedVersion: body.expectedVersion as number, changes, reset: reset as TextGenerationSettingKey[] };
}

export function resolveTextGenerationSettings(state: Workspace, projectId: string | null, enabled: Record<'codex' | 'claude', boolean>): TextGenerationSettingsSnapshot {
  const stored = state.textGenerationSettings ?? textGenerationDefaults();
  // Older saved preferences predate writing styles; resolving them must not
  // require a migration or alter the compare-and-swap version.
  const defaults = { ...textGenerationDefaults().defaults, ...stored.defaults, sourceControlWritingStyle: stored.defaults.sourceControlWritingStyle ?? defaultSourceControlWritingStyle(), reviewGuidesEnabled: stored.defaults.reviewGuidesEnabled ?? false, reviewGuideModelSelection: stored.defaults.reviewGuideModelSelection ?? null, reviewGuideInstructions: stored.defaults.reviewGuideInstructions ?? '' };
  const overrides = projectId && state.projects.some(project => project.id === projectId) && Object.hasOwn(stored.projects, projectId) ? stored.projects[projectId] : {};
  let base = overrides.textGenerationModelSelection ?? stored.defaults.textGenerationModelSelection;
  let baseSource: Source = overrides.textGenerationModelSelection ? 'workspace' : state.textGenerationSettings ? 'host' : 'default';
  // A disabled project choice inherits the host choice before considering a
  // built-in provider fallback, matching T3's project setting resolver.
  if (!enabled[base.agent] && overrides.textGenerationModelSelection && enabled[stored.defaults.textGenerationModelSelection.agent]) { base = stored.defaults.textGenerationModelSelection; baseSource = 'host'; }
  if (!enabled[base.agent]) {
    const fallback = (['codex', 'claude'] as const).find(agent => enabled[agent]);
    if (fallback) { base = defaultFor(fallback); baseSource = 'fallback'; }
  }
  let writer = Object.hasOwn(overrides, 'sourceControlWriterModelSelection') ? overrides.sourceControlWriterModelSelection : stored.defaults.sourceControlWriterModelSelection;
  let writerSource: Source = Object.hasOwn(overrides, 'sourceControlWriterModelSelection') ? 'workspace' : 'host';
  if (!writer || !enabled[writer.agent]) { writer = base; writerSource = 'text_generation'; }
  const guideChoice = Object.hasOwn(overrides, 'reviewGuideModelSelection') ? overrides.reviewGuideModelSelection : defaults.reviewGuideModelSelection;
  const guide = guideChoice && enabled[guideChoice.agent] ? guideChoice : writer;
  return structuredClone({ version: stored.version, projectId, defaults, overrides,
    effective: { textGenerationModelSelection: base, sourceControlWriterModelSelection: writer, sourceControlWritingStyle: overrides.sourceControlWritingStyle ?? defaults.sourceControlWritingStyle, reviewGuidesEnabled: defaults.reviewGuidesEnabled, reviewGuideModelSelection: guide, reviewGuideInstructions: overrides.reviewGuideInstructions ?? defaults.reviewGuideInstructions },
    sources: { textGenerationModelSelection: baseSource, sourceControlWriterModelSelection: writerSource, sourceControlWritingStyle: overrides.sourceControlWritingStyle ? 'workspace' : state.textGenerationSettings?.defaults.sourceControlWritingStyle ? 'host' : 'default',
      reviewGuidesEnabled: state.textGenerationSettings?.defaults.reviewGuidesEnabled !== undefined ? 'host' : 'default', reviewGuideModelSelection: guide === writer ? 'source_control' : Object.hasOwn(overrides, 'reviewGuideModelSelection') ? 'workspace' : 'host', reviewGuideInstructions: overrides.reviewGuideInstructions !== undefined ? 'workspace' : state.textGenerationSettings?.defaults.reviewGuideInstructions !== undefined ? 'host' : 'default' }, enabled });
}

export class TextGenerationPreferences {
  constructor(private readonly engine: Engine) {}
  private async enabled() {
    const [codex, claude] = await Promise.all([loadCodexSettings(this.engine.directory), loadClaudeSettings(this.engine.directory)]);
    return { codex: codex.enabled, claude: claude.enabled };
  }
  async snapshot(projectId: string | null) {
    const state = await this.engine.snapshot();
    if (projectId !== null && (!projectId || reserved.includes(projectId) || !state.projects.some(project => project.id === projectId))) throw new Error('Workspace 不存在');
    return this.resolve(state, projectId, true);
  }
  private async resolve(state: Workspace, projectId: string | null, checkWriter: boolean) {
    const settings = resolveTextGenerationSettings(state, projectId, await this.enabled());
    if (checkWriter && settings.sources.sourceControlWriterModelSelection !== 'text_generation') {
      const writer = settings.effective.sourceControlWriterModelSelection;
      const status = await (writer.agent === 'codex' ? this.engine.codexConnection : this.engine.claudeConnection).status();
      if (!status.enabled || !status.installed || !status.connected) {
        settings.effective.sourceControlWriterModelSelection = settings.effective.textGenerationModelSelection;
        settings.sources.sourceControlWriterModelSelection = 'text_generation';
      }
    }
    if (settings.sources.reviewGuideModelSelection === 'source_control') settings.effective.reviewGuideModelSelection = settings.effective.sourceControlWriterModelSelection;
    return settings;
  }
  async select(state: Workspace, projectId: string | null, kind: 'title' | 'source_control') {
    const settings = await this.resolve(state, projectId, kind === 'source_control');
    const selected = kind === 'title' ? settings.effective.textGenerationModelSelection : settings.effective.sourceControlWriterModelSelection;
    if (!settings.enabled[selected.agent]) throw new Error('没有已启用的文字生成 Provider');
    return selected;
  }
  async reviewGuide(state: Workspace, projectId: string | null) {
    const settings = await this.resolve(state, projectId, true), effective = settings.effective;
    if (!effective.reviewGuidesEnabled) throw new Error('请先在文字生成设置中启用审查 Guide');
    if (!settings.enabled[effective.reviewGuideModelSelection.agent]) throw new Error('没有已启用的 Guide Provider');
    return { modelSelection: effective.reviewGuideModelSelection, instructions: effective.reviewGuideInstructions };
  }
  async sourceControl(state: Workspace, projectId: string | null) {
    const settings = await this.resolve(state, projectId, true);
    const modelSelection = settings.effective.sourceControlWriterModelSelection;
    if (!settings.enabled[modelSelection.agent]) throw new Error('没有已启用的文字生成 Provider');
    return { modelSelection, writingStyle: settings.effective.sourceControlWritingStyle };
  }
  async save(value: unknown) {
    const change = textGenerationSettingsChange(value);
    await this.engine.mutate(state => {
      if (change.projectId && !state.projects.some(project => project.id === change.projectId)) throw new Error('Workspace 不存在');
      const settings = state.textGenerationSettings ?? textGenerationDefaults();
      if (settings.version !== change.expectedVersion) throw new TextGenerationSettingsConflict(settings.version);
      // Reacquire the durable overlay before mutating nested fields.
      state.textGenerationSettings ??= settings; const stored = state.textGenerationSettings;
      let target: TextGenerationScope;
      if (change.projectId) { stored.projects[change.projectId] ??= {}; target = stored.projects[change.projectId]; }
      else target = stored.defaults;
      const { sourceControlWritingStyle, ...models } = change.changes;
      Object.assign(target, models);
      if (sourceControlWritingStyle) target.sourceControlWritingStyle = { ...(target.sourceControlWritingStyle ?? stored.defaults.sourceControlWritingStyle ?? defaultSourceControlWritingStyle()), ...sourceControlWritingStyle };
      for (const key of change.reset) {
        if (change.projectId) delete target[key];
        else if (key === 'textGenerationModelSelection') stored.defaults.textGenerationModelSelection = defaultTextGenerationModel();
        else if (key === 'sourceControlWriterModelSelection') stored.defaults.sourceControlWriterModelSelection = null;
        else if (key === 'sourceControlWritingStyle') stored.defaults.sourceControlWritingStyle = defaultSourceControlWritingStyle();
        else if (key === 'reviewGuidesEnabled') stored.defaults.reviewGuidesEnabled = false;
        else if (key === 'reviewGuideModelSelection') stored.defaults.reviewGuideModelSelection = null;
        else stored.defaults.reviewGuideInstructions = '';
      }
      if (change.projectId && !Object.keys(target).length) delete stored.projects[change.projectId];
      stored.version++;
    });
    return this.snapshot(change.projectId);
  }
}
