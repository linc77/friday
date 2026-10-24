import { acpRecord, type AcpRecord } from './acp-process.js';

// Compatibility follows T3 8cd9641f packages/effect-acp/src/client.ts.
// MIT Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.
export function acpInitializeRequest() {
  const info = { name: 'friday', version: '0.1.0' };
  return { protocolVersion: 2, info, capabilities: {}, clientInfo: info,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, _meta: { clientType: 'extension' } };
}

export function acpInitializeResponse(response: AcpRecord): AcpRecord {
  // Some v1 agents report protocolVersion:2 with the legacy response shape.
  // Only the actual v2 `info` field establishes generation 2.
  if (!('info' in response)) return { ...response, protocolGeneration: 1 };
  if (!acpRecord(response.info) || typeof response.info.name !== 'string') throw new Error('ACP 返回了无效的初始化信息');
  const capabilities = acpRecord(response.capabilities), session = acpRecord(capabilities?.session), prompt = acpRecord(session?.prompt), mcp = acpRecord(session?.mcp);
  return { ...response, protocolGeneration: 2, agentInfo: response.info,
    agentCapabilities: { loadSession: !!session, sessionCapabilities: session ? { resume: {}, ...(acpRecord(session.fork) ? { fork: session.fork } : {}) } : {},
      promptCapabilities: { image: prompt?.image != null, audio: prompt?.audio != null, embeddedContext: prompt?.embeddedContext != null },
      mcpCapabilities: { stdio: mcp?.stdio != null, http: mcp?.http != null } },
    ...(Array.isArray(response.authMethods) ? { authMethods: response.authMethods.map((method: AcpRecord) => ({ ...method, id: method.methodId })) } : {}) };
}

export function acpSessionServers(servers: AcpRecord[], generation: unknown) {
  return generation === 2 ? servers.map(server => server.type ? server : { ...server, type: 'stdio' }) : servers;
}

export function acpPermissionRequest(params: AcpRecord, requestId: unknown): AcpRecord {
  if (acpRecord(params.toolCall)) return params;
  const subject = acpRecord(params.subject);
  const toolCall = subject?.type === 'tool_call' && acpRecord(subject.toolCall) ? subject.toolCall
    : { toolCallId: typeof subject?.toolCallId === 'string' ? subject.toolCallId : String(requestId), title: params.title, kind: subject?.type === 'command' ? 'execute' : 'other' };
  return { ...params, toolCall };
}

export function acpModelOption(session: AcpRecord): AcpRecord | undefined {
  return Array.isArray(session.configOptions) ? session.configOptions.find((option: AcpRecord) => option.category === 'model' && typeof (option.configId ?? option.id) === 'string') : undefined;
}

export function acpEffortOption(session: AcpRecord): AcpRecord | undefined {
  return Array.isArray(session.configOptions) ? session.configOptions.find((option: AcpRecord) => option.category === 'thought_level' || /^(reasoning[_-]?effort|thinking[_-]?level)$/i.test(option.configId ?? option.id ?? '')) : undefined;
}

export function acpConfigValues(option: AcpRecord): string[] {
  return (Array.isArray(option.options) ? option.options : []).flatMap((value: AcpRecord) => Array.isArray(value.options) ? acpConfigValues(value) : typeof value.value === 'string' ? [value.value] : []);
}
