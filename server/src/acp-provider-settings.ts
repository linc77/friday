import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultCodexSettings, validateSettings, type CodexSettings } from './codex-settings.js';
import { acpRecord } from './acp-process.js';
import { acpRegistryAgentID, type AcpDistributionKind } from './acp-registry-catalog.js';
import type { AntigravityAuthMethod } from './antigravity-profile.js';
export type AcpProviderID = 'acp-registry' | 'antigravity';
export type AcpProviderConfig = { source: 'registry' | 'local'; registryAgentId: string; commandArgs: string[]; authMethodId: string; distribution: 'auto' | AcpDistributionKind; commandOverride: string; harnessPath: string; authMethod: AntigravityAuthMethod; apiKey: string; gcpProject: string; gcpLocation: string };
export type AcpProviderPublicConfig = Omit<AcpProviderConfig, 'apiKey'> & { apiKey: null; apiKeyConfigured: boolean };
export type AcpProviderSettings = CodexSettings & { nativeConfig: AcpProviderConfig };
export const acpProviderName = (provider: AcpProviderID) => provider === 'antigravity' ? 'Antigravity' : 'ACP Registry';
export const acpProviderDefaults = (provider: AcpProviderID): AcpProviderSettings => ({ ...defaultCodexSettings, enabled: false, permissionMode: 'default', displayName: acpProviderName(provider), binaryPath: provider === 'antigravity' ? 'agy_acp_server.par' : 'acp', nativeConfig: { source: 'registry', registryAgentId: '', commandArgs: [], authMethodId: '', distribution: 'auto', commandOverride: '', harnessPath: '', authMethod: 'oauth-personal', apiKey: '', gcpProject: '', gcpLocation: '' } });
export function acpProviderSettings(provider: AcpProviderID, value: unknown, previous = acpProviderDefaults(provider)): AcpProviderSettings {
  const input = acpRecord(value), effort = typeof input?.reasoningEffort === 'string' ? input.reasoningEffort.trim() : '';
  if (effort && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(effort)) throw new Error('ACP 原生推理选项格式无效');
  const base = validateSettings(input ? { ...input, reasoningEffort: effort } : value, previous, acpProviderName(provider), effort ? [effort] : []);
  if (base.homePath || base.shadowHomePath || base.launchArgs) throw new Error('ACP 工具的账号和启动方式请使用原生配置');
  const raw = input?.nativeConfig === undefined ? previous.nativeConfig : acpRecord(input.nativeConfig); if (!raw) throw new Error('ACP 原生配置格式无效');
  const text = (name: keyof AcpProviderConfig, maximum: number) => { const value = raw[name] ?? previous.nativeConfig[name] ?? ''; if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw new Error('ACP 原生配置字段无效'); return value.trim(); };
  const source = raw.source ?? previous.nativeConfig.source, distribution = raw.distribution ?? previous.nativeConfig.distribution, authMethod = raw.authMethod ?? previous.nativeConfig.authMethod, registryAgentId = text('registryAgentId', 128), args = raw.commandArgs ?? previous.nativeConfig.commandArgs;
  if (!['registry', 'local'].includes(source) || !['auto', 'binary', 'npx', 'uvx'].includes(distribution) || !['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform'].includes(authMethod) || !Array.isArray(args) || args.length > 64 || args.some(value => typeof value !== 'string' || value.length > 1024 || value.includes('\0'))) throw new Error('ACP 原生配置选项无效');
  if (registryAgentId) acpRegistryAgentID(registryAgentId);
  const secret = raw.apiKey === null || raw.apiKey === undefined ? previous.nativeConfig.apiKey : raw.apiKey; if (typeof secret !== 'string' || secret.length > 16384 || secret.includes('\0')) throw new Error('Antigravity 密钥格式无效');
  const nativeConfig: AcpProviderConfig = { source, registryAgentId, commandArgs: [...args], authMethodId: text('authMethodId', 128), distribution, commandOverride: text('commandOverride', 2048), harnessPath: text('harnessPath', 2048), authMethod, apiKey: secret, gcpProject: text('gcpProject', 256), gcpLocation: text('gcpLocation', 256) };
  return { ...base, nativeConfig };
}
export async function loadAcpProviderSettings(directory: string, provider: AcpProviderID) {
  try { return acpProviderSettings(provider, JSON.parse(await readFile(join(directory, provider + '-provider.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return acpProviderDefaults(provider); throw error; }
}
export const acpProviderAccount = (provider: AcpProviderID, settings: AcpProviderSettings) => createHash('sha256').update(JSON.stringify([provider, settings.binaryPath, settings.environment.toSorted((a, b) => a.name.localeCompare(b.name)), settings.nativeConfig])).digest('hex');
export const acpProviderPublicSettings = (settings: AcpProviderSettings) => ({ ...settings, nativeConfig: { ...settings.nativeConfig, apiKey: null, apiKeyConfigured: !!settings.nativeConfig.apiKey } satisfies AcpProviderPublicConfig, environment: settings.environment.map(entry => ({ name: entry.name, value: null, hasValue: true })) });
