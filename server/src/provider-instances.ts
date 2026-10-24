import { supportsTextGeneration, supportsInvestigation } from './native-text-generation.js';
import { providerOptionDescriptors } from './provider-models.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Executor, WorkItem } from './types.js';
import type { CodexConnection } from './codex-provider.js';
import type { ClaudeConnection } from './claude-provider.js';
import type { PiConnection } from './pi-provider.js';
import type { GrokConnection } from './grok-provider.js';
import type { CursorConnection } from './cursor-provider.js';
import type { MuseConnection } from './muse-provider.js';
import type { OpenCodeConnection } from './opencode-provider.js';
import type { AcpProviderConnection } from './acp-provider.js';

export const providerDrivers = ['codex', 'claude', 'pi', 'grok', 'cursor', 'muse', 'opencode', 'acp-registry', 'antigravity'] as const;
export type ProviderDriver = typeof providerDrivers[number];
export type ProviderConnections = { codex: CodexConnection; claude: ClaudeConnection; pi: PiConnection; grok: GrokConnection; cursor: CursorConnection; muse: MuseConnection; opencode: OpenCodeConnection; 'acp-registry': AcpProviderConnection; antigravity: AcpProviderConnection };
export type ProviderBundle = { connection: ProviderConnections[ProviderDriver]; executor: Executor };
type Instance = { instanceId: string; driver: ProviderDriver; displayName: string; accentColor?: string; enabled: boolean; storageKey?: string; removed?: boolean };
export const providerInstanceID = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value.trim()) || ['__proto__', 'constructor', 'prototype'].includes(value.trim())) throw new Error('Provider 实例 ID 无效');
  return value.trim();
};
export const taskProviderInstance = (task: Pick<WorkItem, 'agent' | 'providerInstanceId'>) => task.providerInstanceId ?? task.agent;

/** Instance IDs are continuation identities, never a mutable alias for another
 * account. Legacy tasks retain their driver-named default. Private config and
 * native connection state live in independent directories for added instances. */
export class ProviderInstances {
  private records?: Instance[];
  private loading?: Promise<Instance[]>;
  private bundles = new Map<string, ProviderBundle>();
  private gate: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private directory: string, private factory: (driver: ProviderDriver, directory: string) => ProviderBundle,
    private changed: (instanceId: string, driver: ProviderDriver) => Promise<void>,
    private referenced: (instanceId: string, activeOnly?: boolean) => Promise<boolean>) {
    for (const driver of providerDrivers) this.bind(driver, driver, factory(driver, directory));
  }
  private bind(id: string, driver: ProviderDriver, bundle: ProviderBundle) {
    bundle.connection.onConfigurationChanged = () => this.changed(id, driver);
    this.bundles.set(id, bundle); return bundle;
  }
  default<K extends ProviderDriver>(driver: K): ProviderConnections[K] { return this.bundles.get(driver)!.connection as ProviderConnections[K]; }
  defaultExecutors() { return Object.fromEntries(providerDrivers.map(driver => [driver, this.bundles.get(driver)!.executor])); }
  private async read() {
    if (this.records) return this.records;
    if (!this.loading) this.loading = (async () => {
      let saved: Instance[] = [];
      try {
        const data: unknown = JSON.parse(await readFile(join(this.directory, 'provider-instances.json'), 'utf8'));
        if (!Array.isArray(data)) throw new Error('Provider 实例目录损坏');
        const ids = new Set<string>();
        saved = data.map((raw: Instance) => {
          const id = providerInstanceID(raw.instanceId);
          if (ids.has(id) || !providerDrivers.includes(raw.driver) || typeof raw.enabled !== 'boolean' || typeof raw.displayName !== 'string' || raw.displayName.length > 80 || (raw.storageKey !== undefined && !/^[0-9a-f-]{36}$/.test(raw.storageKey)) || (providerDrivers.includes(id as ProviderDriver) && raw.driver !== id)) throw new Error('Provider 实例目录损坏');
          ids.add(id); return { ...raw, instanceId: id };
        });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.records = [...providerDrivers.filter(driver => !saved.some(value => value.instanceId === driver)).map(driver => ({ instanceId: driver, driver, displayName: driver, enabled: true })), ...saved];
      return this.records;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }
  async list() { return (await this.read()).filter(value => !value.removed).map(({ storageKey: _storage, removed: _removed, ...value }) => value); }
  async get<K extends ProviderDriver>(driver: K, instanceId: unknown = driver, requireEnabled = false): Promise<ProviderConnections[K]> {
    if (this.closed) throw new Error('Provider 服务已关闭');
    const id = providerInstanceID(instanceId), record = (await this.read()).find(value => value.instanceId === id && !value.removed);
    if (!record || record.driver !== driver) throw new Error('任务所属 Provider 实例不可用，请恢复原实例');
    if (requireEnabled && !record.enabled) throw new Error('任务所属 Provider 实例已停用');
    if (!this.bundles.has(id)) {
      if (!record.storageKey) throw new Error('Provider 实例配置目录缺失');
      const path = join(this.directory, 'provider-instances', record.storageKey);
      await mkdir(path, { recursive: true, mode: 0o700 });
      if (this.closed || !(await this.read()).some(value => value.instanceId === id && !value.removed && (!requireEnabled || value.enabled))) throw new Error('Provider 实例已改变');
      // Recheck after I/O: concurrent callers must share one native owner.
      if (!this.bundles.has(id)) this.bind(id, driver, this.factory(driver, path));
    }
    return this.bundles.get(id)!.connection as ProviderConnections[K];
  }
  async configDirectory(driver: ProviderDriver, instanceId: string) {
    instanceId = providerInstanceID(instanceId);
    await this.get(driver, instanceId);
    const record = (await this.read()).find(value => value.instanceId === instanceId)!;
    return record.storageKey ? join(this.directory, 'provider-instances', record.storageKey) : this.directory;
  }
  async status<K extends ProviderDriver>(driver: K, instanceId: string = driver, owner = false, reload = false) {
    instanceId = providerInstanceID(instanceId);
    const connection = await this.get(driver, instanceId), state = await connection.status(owner, reload);
    const record = (await this.read()).find(value => value.instanceId === instanceId && !value.removed);
    if (!record) throw new Error('Provider 实例已移除');
    return { ...state, supportsTextGeneration: supportsTextGeneration(driver) && (driver !== 'antigravity' || state.supportsPlan === true), supportsInvestigation: supportsInvestigation(driver), enabled: record.enabled && state.enabled, connected: record.enabled && state.connected, models: state.models.map(model => ({ ...model, optionDescriptors: providerOptionDescriptors(model) })) };
  }
  async credentialPeers(driver: ProviderDriver, instanceId: string) {
    if (driver !== 'acp-registry') return [instanceId];
    const connection = await this.get(driver, instanceId), key = await connection.credentialKey(), peers: string[] = [];
    for (const instance of await this.list()) if (instance.driver === driver && await (await this.get(driver, instance.instanceId)).credentialKey() === key) peers.push(instance.instanceId);
    return peers;
  }
  async forTask(task: Pick<WorkItem, 'agent' | 'providerInstanceId'>) { return this.get(task.agent as ProviderDriver, taskProviderInstance(task), true); }
  async executor(task: WorkItem) { await this.forTask(task); return this.bundles.get(taskProviderInstance(task))!.executor; }
  async change(input: unknown) {
    const operation = this.gate.then(async () => {
      if (this.closed) throw new Error('Provider 服务已关闭');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provider 实例配置无效');
      const value = input as Record<string, unknown>, id = providerInstanceID(value.instanceId), records = await this.read(), previous = records.find(record => record.instanceId === id);
      let next = records.map(record => ({ ...record }));
      if (value.operation === 'remove') {
        if (!previous || previous.removed) throw new Error('Provider 实例不存在');
        if (!previous.storageKey) throw new Error('默认 Provider 实例不能移除，可在设置中停用');
        if (await this.referenced(id)) throw new Error('此实例仍有关联任务或生成操作，请保留实例以便恢复会话');
        next.find(record => record.instanceId === id)!.removed = true;
      } else {
        if (!['create', 'upsert'].includes(String(value.operation)) || (value.operation === 'create' && previous) || previous?.removed) throw new Error('Provider 实例 ID 已使用');
        const raw = value.instance;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Provider 实例配置无效');
        const data = raw as Record<string, unknown>;
        if (!providerDrivers.includes(data.driver as ProviderDriver) || previous && previous.driver !== data.driver || typeof data.displayName !== 'string' || !data.displayName.trim() || data.displayName.trim().length > 80 || typeof data.enabled !== 'boolean' || data.accentColor !== undefined && (typeof data.accentColor !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(data.accentColor))) throw new Error('Provider 实例配置无效');
        if (previous && !data.enabled && await this.referenced(id, true)) throw new Error('请先停止此实例的任务和生成操作再停用');
        const record: Instance = { instanceId: id, driver: data.driver as ProviderDriver, displayName: data.displayName.trim(), enabled: data.enabled, ...(data.accentColor ? { accentColor: data.accentColor as string } : {}), ...(previous?.storageKey ? { storageKey: previous.storageKey } : previous ? {} : { storageKey: randomUUID() }) };
        if (previous) next = next.map(entry => entry.instanceId === id ? record : entry); else next.push(record);
      }
      const path = join(this.directory, 'provider-instances.json'), temporary = path + '.' + randomUUID() + '.tmp';
      try { await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); this.records = next; }
      finally { await rm(temporary, { force: true }); }
      if (value.operation === 'remove') { const bundle = this.bundles.get(id); this.bundles.delete(id); await bundle?.executor.close?.(); await bundle?.connection.close(); }
      await this.changed(id, (next.find(entry => entry.instanceId === id)!).driver);
      return this.list();
    });
    this.gate = operation.catch(() => {}); return operation;
  }
  async close() { this.closed = true; await this.gate; await Promise.all([...this.bundles.values()].map(async bundle => { await bundle.executor.close?.(); await bundle.connection.close(); })); this.bundles.clear(); }
}
