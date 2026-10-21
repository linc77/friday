import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeToolHTTPS, nativeToolPath } from './native-tool-archive.js';
import { acpRecord, type AcpRecord } from './acp-process.js';
import { findExecutable } from './agents.js';

// Adapted from T3 8cd9641f provider-acp-registry/server/AcpRegistrySupport.ts.
// MIT Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.
export const acpRegistryURL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
export type AcpDistributionKind = 'binary' | 'npx' | 'uvx';
type PackageDistribution = { package: string; args?: string[]; env?: Record<string, string> };
export type AcpRegistryBinary = { archive: string; cmd: string; sha256?: string; args?: string[]; env?: Record<string, string> };
export type AcpRegistryAgent = { id: string; name: string; version: string; description: string; authors?: string[]; license?: string; website?: string; repository?: string; icon?: string; distribution: { binary?: Record<string, AcpRegistryBinary>; npx?: PackageDistribution; uvx?: PackageDistribution } };
export type AcpRegistryIndex = { version: string; agents: AcpRegistryAgent[] };
export type AcpRegistryDistribution = { kind: AcpDistributionKind; args: string[]; env: Record<string, string>; target?: string; binary?: AcpRegistryBinary; package?: string };
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const exactVersion = 'v?[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?';
const npxPattern = new RegExp(`^(?:@[^/@\\s]+/[^@\\s]+|[a-z0-9][a-z0-9._-]*)@${exactVersion}$`, 'i');
const uvxPattern = new RegExp(`^[a-z0-9][a-z0-9._-]*(?:@|==)${exactVersion}$`, 'i');
export function parseAcpRegistryPackage(value: string, kind: 'npx' | 'uvx') {
  if (value.length > 256 || !(kind === 'npx' ? npxPattern : uvxPattern).test(value)) throw new Error('工具包需要固定准确版本');
  const equals = kind === 'uvx' ? value.lastIndexOf('==') : -1, separator = equals >= 0 ? equals : value.lastIndexOf('@');
  return { name: value.slice(0, separator), version: value.slice(separator + (equals >= 0 ? 2 : 1)).replace(/^v/i, '') };
}
export function acpRegistryAgentID(value: unknown): string { if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new Error('ACP Registry 工具标识无效'); return value; }
const bounded = (value: unknown, maximum: number, allowEmpty = false): value is string => typeof value === 'string' && value.length <= maximum && (allowEmpty || !!value.trim());
function distributionFields(value: AcpRecord) {
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 64 || !value.args.every((arg: unknown) => bounded(arg, 1024, true) && !arg.includes('\0')))) throw new Error('Invalid ACP arguments');
  if (value.env !== undefined && (!acpRecord(value.env) || Object.keys(value.env).length > 256 || !Object.entries(value.env).every(([name, value]) => bounded(name, 256) && !/[=\0]/.test(name) && bounded(value, 1024, true) && !value.includes('\0')))) throw new Error('Invalid ACP environment');
  return { ...(value.args ? { args: value.args as string[] } : {}), ...(value.env ? { env: value.env as Record<string, string> } : {}) };
}
function registryAgent(value: unknown): AcpRegistryAgent | undefined {
  try {
    const input = acpRecord(value), distribution = acpRecord(input?.distribution); if (!input || !distribution) return;
    acpRegistryAgentID(input.id);
    if (!bounded(input.name, 160) || !bounded(input.version, 128) || !versionPattern.test(input.version) || !bounded(input.description, 1024, true)) return;
    const result: AcpRegistryAgent = { id: input.id, name: input.name.trim(), version: input.version.trim(), description: input.description, distribution: {} };
    if (input.authors !== undefined) { if (!Array.isArray(input.authors) || input.authors.length > 16 || !input.authors.every((value: unknown) => bounded(value, 256, true))) return; result.authors = input.authors; }
    if (input.license !== undefined) { if (!bounded(input.license, 128, true)) return; result.license = input.license; }
    for (const key of ['website', 'repository', 'icon'] as const) if (input[key] !== undefined) result[key] = nativeToolHTTPS(input[key]).href;
    for (const kind of ['npx', 'uvx'] as const) {
      if (distribution[kind] === undefined) continue; const packageInfo = acpRecord(distribution[kind]); if (!packageInfo || !bounded(packageInfo.package, 256) || !(kind === 'npx' ? npxPattern : uvxPattern).test(packageInfo.package)) return;
      result.distribution[kind] = { package: packageInfo.package, ...distributionFields(packageInfo) };
    }
    if (distribution.binary !== undefined) {
      const binaries = acpRecord(distribution.binary); if (!binaries || Object.keys(binaries).length > 32) return; result.distribution.binary = {};
      for (const [target, raw] of Object.entries(binaries)) {
        const binary = acpRecord(raw); if (!binary || !bounded(binary.cmd, 1024)) return; nativeToolPath(binary.cmd);
        if (binary.sha256 !== undefined && (typeof binary.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(binary.sha256))) return;
        result.distribution.binary[target] = { archive: nativeToolHTTPS(binary.archive).href, cmd: binary.cmd, ...(binary.sha256 ? { sha256: binary.sha256.toLowerCase() } : {}), ...distributionFields(binary) };
      }
    }
    return result;
  } catch { return; }
}
export function decodeAcpRegistry(text: string): AcpRegistryIndex {
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('ACP Registry 索引超过 1 MiB');
  const value = acpRecord(JSON.parse(text)); if (!value || !bounded(value.version, 128) || !versionPattern.test(value.version) || !Array.isArray(value.agents) || value.agents.length > 512) throw new Error('ACP Registry 索引格式无效');
  const seen = new Set<string>(); return { version: value.version, agents: value.agents.flatMap((value: unknown) => { const agent = registryAgent(value); if (!agent || seen.has(agent.id)) return []; seen.add(agent.id); return [agent]; }) };
}
export function acpRegistryTarget(platform: NodeJS.Platform = process.platform, architecture: string = process.arch) {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform as 'darwin'], arch = architecture === 'arm64' ? 'aarch64' : architecture === 'x64' ? 'x86_64' : undefined;
  return os && arch ? `${os}-${arch}` : undefined;
}
export function resolveAcpDistribution(agent: AcpRegistryAgent, preference: 'auto' | AcpDistributionKind = 'auto', target = acpRegistryTarget()): AcpRegistryDistribution | undefined {
  const targets = target === 'windows-aarch64' ? ['windows-aarch64', 'windows-x86_64'] : target ? [target] : [];
  for (const kind of preference === 'auto' ? ['binary', 'npx', 'uvx'] as const : [preference]) {
    if (kind === 'binary') { const selected = targets.find(target => agent.distribution.binary?.[target]); if (selected) { const binary = agent.distribution.binary![selected]!; return { kind, binary, target: selected, args: binary.args ?? [], env: binary.env ?? {} }; } }
    else { const selected = agent.distribution[kind]; if (selected) return { kind, package: selected.package, args: selected.args ?? [], env: selected.env ?? {} }; }
  }
}
export function acpRegistryRank(agent: AcpRegistryAgent, query: string) {
  const normalized = query.trim().toLowerCase(); if (!normalized) return 100;
  const id = agent.id.toLowerCase(), name = agent.name.toLowerCase(), authors = (agent.authors ?? []).join(' ').toLowerCase(), description = agent.description.toLowerCase(), terms = normalized.split(/\s+/u);
  if (id === normalized || name === normalized) return 0; if (id.startsWith(normalized) || name.startsWith(normalized)) return 10;
  const tokens = `${id} ${name}`.split(/[^a-z0-9]+/u).filter(Boolean); if (terms.every(term => tokens.some(token => token.startsWith(term)))) return 20;
  if (terms.every(term => id.includes(term) || name.includes(term))) return 30; if (terms.every(term => authors.includes(term))) return 40;
  if (terms.every(term => `${id} ${name} ${authors} ${description}`.includes(term))) return 50;
}
export class AcpRegistryCatalog {
  private cached?: { index: AcpRegistryIndex; at: number };
  private pending?: Promise<AcpRegistryIndex>;
  constructor(readonly directory: string, private options: { fetch?: typeof fetch; url?: string } = {}) {}
  async index(reload = false): Promise<AcpRegistryIndex> {
    if (!reload && this.cached && Date.now() - this.cached.at < 10 * 60000) return this.cached.index;
    if (this.pending) return this.pending;
    return this.pending = (async () => {
      const cache = join(this.directory, 'acp-registry', 'index.json');
      try {
        const response = await (this.options.fetch ?? fetch)(nativeToolHTTPS(this.options.url ?? acpRegistryURL), { signal: AbortSignal.timeout(30000), redirect: 'error' });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Registry unavailable'); }
        const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', bytes = 0;
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 1024 * 1024) throw new Error('Registry exceeds limit'); text += decoder.decode(chunk.value, { stream: true }); } text += decoder.decode(); }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const index = decodeAcpRegistry(text); await mkdir(join(this.directory, 'acp-registry'), { recursive: true, mode: 0o700 }); const temp = cache + '.' + randomUUID() + '.tmp';
        try { await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, cache); } finally { await rm(temp, { force: true }); }
        this.cached = { index, at: Date.now() }; return index;
      } catch {
        try { const index = this.cached?.index ?? decodeAcpRegistry(await readFile(cache, 'utf8')); this.cached = { index, at: Date.now() }; return index; }
        catch { throw new Error('ACP Registry 暂不可用，且主机没有可用缓存'); }
      }
    })().finally(() => { this.pending = undefined; });
  }
  async agent(id: string) { const selected = acpRegistryAgentID(id), value = (await this.index()).agents.find(agent => agent.id === selected); if (!value) throw new Error('ACP Registry 中没有此工具'); return value; }
  async search(query: string, reload = false) {
    if (typeof query !== 'string' || query.length > 256) throw new Error('ACP Registry 搜索内容过长');
    const index = await this.index(reload);
    return { agents: index.agents.flatMap(agent => { const rank = acpRegistryRank(agent, query), distribution = resolveAcpDistribution(agent); return rank === undefined || !distribution || distribution.kind !== 'binary' && !findExecutable(distribution.kind === 'npx' ? 'npm' : 'uv') ? [] : [{ agent, rank, distribution }]; }).sort((a, b) => a.rank - b.rank || a.agent.name.localeCompare(b.agent.name)).slice(0, 20).map(({ agent, distribution }) => ({ id: agent.id, name: agent.name, version: agent.version, description: agent.description, authors: agent.authors ?? [], license: agent.license ?? null, website: agent.website ?? null, repository: agent.repository ?? null, icon: agent.icon ?? null, distribution: distribution.kind, integrity: distribution.binary?.sha256 ? 'sha256' : 'registry' })) };
  }
}
