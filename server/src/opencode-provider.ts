import { selectedProviderOptions, type ProviderModelSelection, type ProviderOptionDescriptor } from './provider-models.js';
import { NativeProviderConnection, loadNativeProviderSettings, type NativeProviderSettings } from './native-provider-config.js';
import { OpenCodeServer, type OpenCodeGeneration } from './opencode-server.js';
import { acpRecord, type AcpRecord } from './acp-process.js';
import type { ProviderModel } from './provider-models.js';
import type { ModelStatus } from './codex-provider.js';
import type { ProviderWorkspace } from './provider-workspace.js';
import type { WorkItem } from './types.js';

export type OpenCodeModel = ProviderModel & { providerID: string; nativeModelId: string; contextWindow?: number };
export function openCodeModels(value: unknown, generation: OpenCodeGeneration): OpenCodeModel[] {
  const input = acpRecord(value), seen = new Set<string>();
  const all: AcpRecord[] = generation === 2 ? Array.isArray(input?.data) ? input.data : [] : (Array.isArray(input?.all) ? input.all : []).filter((provider: AcpRecord) => input?.connected?.includes(provider.id)).flatMap((provider: AcpRecord) => Object.values(provider.models ?? {}).map((model: any) => ({ ...model, providerID: provider.id })));
  return all.flatMap((model): OpenCodeModel[] => {
    const nativeModelId = typeof model?.id === 'string' ? model.id.trim() : '', providerID = typeof model?.providerID === 'string' ? model.providerID.trim() : '', id = providerID + '/' + nativeModelId;
    if (!nativeModelId || !providerID || seen.has(id) || model.enabled === false) return []; seen.add(id);
    const variants = generation === 2 ? (Array.isArray(model.variants) ? model.variants : []).map((value: AcpRecord) => value.id) : Object.keys(model.variants ?? {});
    const context = model.limit?.input ?? model.limit?.context;
    return [{ id, name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : nativeModelId, description: '', isDefault: generation === 1 && input?.default?.[providerID] === nativeModelId,
      reasoningEfforts: [...new Set<string>(variants.filter((value: unknown): value is string => typeof value === 'string' && !!value.trim()))], defaultReasoningEffort: '', providerID, nativeModelId,
      ...(Number.isFinite(context) && context > 0 ? { contextWindow: context } : {}) }];
  });
}
export async function openCodeData(pending: PromiseLike<unknown>): Promise<AcpRecord> {
  const result = acpRecord(await pending);
  if (!result || result.error) throw new Error(typeof result?.error?.message === 'string' ? result.error.message : 'OpenCode SDK 请求失败');
  return acpRecord(result.data) ?? result;
}
type Pool = { promise: Promise<OpenCodeServer>; users: number; timer?: NodeJS.Timeout; close(): Promise<void> };
export type OpenCodeLease = { server: OpenCodeServer; close(): Promise<void> };
export class OpenCodeConnection extends NativeProviderConnection {
  private pool = new Map<string, Pool>();
  constructor(directory: string) { super(directory, 'opencode'); }
  async server(settings: NativeProviderSettings, cwd: string, owner?: string): Promise<OpenCodeLease> {
    if (this.closed) throw new Error('OpenCode 连接已关闭');
    const key = JSON.stringify([settings, cwd, owner]); let entry = this.pool.get(key);
    if (!entry) {
      const promise = OpenCodeServer.connect(settings, cwd);
      let closing: Promise<void> | undefined;
      const value: Pool = { promise, users: 0, close: () => closing ??= (async () => { clearTimeout(value.timer); try { await (await promise).close(); } catch {} if (this.pool.get(key) === value) this.pool.delete(key); this.resources.delete(value); })() };
      this.own(value); this.pool.set(key, value); entry = value;
    }
    const current = entry; clearTimeout(current.timer); current.users++;
    try {
      const server = await current.promise;
      if (!server.available) { current.users--; await current.close(); return this.server(settings, cwd, owner); }
      let returned = false;
      return { server, close: async () => { if (returned) return; returned = true; current.users--; if (current.users === 0) current.timer = setTimeout(() => { if (current.users === 0) void current.close(); }, 30_000); } };
    } catch (error) { current.users--; await current.close(); throw error; }
  }
  protected async probe(settings: NativeProviderSettings): Promise<ModelStatus> {
    const state = this.empty(settings); if (!settings.enabled) return state;
    let lease: Awaited<ReturnType<OpenCodeConnection['server']>> | undefined;
    try {
      lease = await this.server(settings, this.directory); const server = lease.server; state.installed = true; state.version = server.version;
      const models = server.generation === 2 ? await server.v2!.model.list({ location: { directory: this.directory } }, { signal: AbortSignal.timeout(5000) }) : await server.v1!.provider.list({}, { signal: AbortSignal.timeout(5000) }).then(value => value.data);
      state.models = openCodeModels(models, server.generation);
      try {
        const raw = server.generation === 2 ? await server.v2!.agent.list({ location: { directory: this.directory } }, { signal: AbortSignal.timeout(5000) }) : await server.v1!.app.agents(undefined, { signal: AbortSignal.timeout(5000) }).then(value => value.data);
        const listed = Array.isArray(raw) ? raw : acpRecord(raw)?.data;
        const agents = (Array.isArray(listed) ? listed : []).filter((agent: AcpRecord) => typeof agent.name === 'string' && agent.name && !agent.hidden && agent.mode !== 'subagent');
        if (agents.length) for (const model of state.models) model.optionDescriptors = [{ id: 'agent', label: 'Agent', type: 'select', options: agents.map((agent: AcpRecord) => ({ id: agent.name, label: agent.name, ...(agent.name === 'build' ? { isDefault: true } : {}) })), currentValue: agents.some((agent: AcpRecord) => agent.name === 'build') ? 'build' : agents[0].name }];
      } catch {}
      state.connected = state.models.length > 0;
      state.model = settings.model || state.models.find(value => value.isDefault)?.id || state.models[0]?.id || '';
      if (!state.connected) state.error = 'OpenCode 没有返回已连接供应商的模型，请在主机完成账号配置';
    } catch (error) { state.error = error instanceof Error ? error.message : 'OpenCode 检测失败'; }
    finally { await lease?.close(); }
    return state;
  }
  async runtime(selection?: ProviderModelSelection) {
    const value = await super.runtime(selection), model = (await this.status()).models.find(model => model.id === value.model) as OpenCodeModel | undefined;
    // Custom model IDs stay explicit provider/model pairs; their server may
    // accept them, but no reasoning capability is inferred from the ID.
    const slash = value.model.indexOf('/'), providerID = model?.providerID ?? value.model.slice(0, slash), modelID = model?.nativeModelId ?? value.model.slice(slash + 1);
    if (slash < 1 || !modelID) throw new Error('OpenCode 模型需要使用 provider/model 标识');
    return { ...value, providerID, modelID, ...(typeof value.modelOptions.agent === 'string' ? { agent: value.modelOptions.agent } : {}), contextWindow: model?.contextWindow };
  }
  async workspace(cwd: string, reload = false, task?: WorkItem): Promise<ProviderWorkspace> {
    const runtime = await this.runtime(); if (task?.nativeProviderAccount && task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条 OpenCode 会话使用的账号配置');
    return this.catalogs.read(JSON.stringify([runtime.settings, cwd]), reload, async () => {
      const lease = await this.server(runtime.settings, cwd);
      try {
        const server = lease.server, [commands, skills] = server.generation === 2
          ? await Promise.all([server.v2!.command.list({ location: { directory: cwd } }), server.v2!.skill.list({ location: { directory: cwd } })])
          : await Promise.all([server.v1!.command.list({}), server.v1!.app.skills({})]);
        const rawCommands = Array.isArray((commands as any)?.data) ? (commands as any).data : [], rawSkills = Array.isArray((skills as any)?.data) ? (skills as any).data : [];
        return { provider: 'opencode', cwd, checkedAt: new Date().toISOString(), commands: [{ name: 'compact', builtin: true, description: 'Summarize this conversation' }, ...rawCommands.filter((value: any) => typeof value?.name === 'string' && value.name !== 'compact').map((value: any) => ({ name: value.name, description: value.description }))],
          skills: rawSkills.flatMap((value: any) => typeof (value.name ?? value.id) === 'string' && typeof (value.location ?? value.path) === 'string' ? [{ name: value.name ?? value.id, path: value.location ?? value.path, enabled: true, ...(typeof value.description === 'string' ? { description: value.description } : {}) }] : []) };
      } finally { await lease.close(); }
    });
  }
  async configured() { return loadNativeProviderSettings(this.directory, 'opencode'); }
}
