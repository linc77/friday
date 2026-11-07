/* Adapted from T3 Code 8cd9641f provider/CodexMcpElicitation.ts.
 * MIT, Copyright (c) 2026 T3 Tools Inc. Full license in provider-usage-limits.ts.
 * Field validation mirrors the pinned Schema.Struct checks without importing
 * the provider's execution runtime. Payloads remain data, never instructions.
 */
import type { ApprovalDecision } from './provider-approvals.js';
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type ApprovalOption = { decision: ApprovalDecision; label: string; warning?: string };
export type McpElicitationParams = { mode: string; serverName: string; message: string; threadId?: string; turnId?: string | null; elicitationId?: string; url?: string; requestedSchema?: unknown; _meta?: unknown };
export type McpElicitationResponse = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, Json>; _meta?: { persist: string } };
type McpFormField = { type?: string | null; title?: string | null; description?: string | null; default?: Json; enum?: string[] | null; enumNames?: string[] | null; oneOf?: { const: string; title?: string | null }[] | null };
type McpForm = { properties?: Record<string, McpFormField>; required?: string[] | null };
type McpMetadata = { app?: string | null; app_name?: string | null; appName?: string | null; connector_name?: string | null; connectorName?: string | null; allowPersistentApproval?: boolean | null; persist?: string | string[] | null; target?: { app?: string | null; name?: string | null } | null; tool_params?: { app?: string | null; app_name?: string | null } | null };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown) => value === undefined || value === null || typeof value === 'string';
const nullableStrings = (value: unknown) => value === undefined || value === null || Array.isArray(value) && value.every(item => typeof item === 'string');
function isJson(value: unknown): value is Json { return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || Array.isArray(value) && value.every(isJson) || record(value) && Object.values(value).every(isJson); }
function isMcpElicitationMetadata(value: unknown): value is McpMetadata {
  if (!record(value) || !['app','app_name','appName','connector_name','connectorName'].every(key => nullableString(value[key]))) return false;
  if (value.allowPersistentApproval !== undefined && value.allowPersistentApproval !== null && typeof value.allowPersistentApproval !== 'boolean') return false;
  if (typeof value.persist !== 'string' && !nullableStrings(value.persist)) return false;
  for (const [key, fields] of [['target',['app','name']],['tool_params',['app','app_name']]] as const) {
    const nested = value[key]; if (nested !== undefined && nested !== null && (!record(nested) || !fields.every(field => nullableString(nested[field])))) return false;
  }
  return true;
}
function isMcpElicitationForm(value: unknown): value is McpForm {
  if (!record(value) || !nullableStrings(value.required)) return false;
  if (value.properties === undefined) return true;
  if (!record(value.properties)) return false;
  return Object.values(value.properties).every(field => record(field)
    && ['type','title','description'].every(key => nullableString(field[key]))
    && (field.default === undefined || isJson(field.default))
    && nullableStrings(field.enum) && nullableStrings(field.enumNames)
    && (field.oneOf === undefined || field.oneOf === null || Array.isArray(field.oneOf) && field.oneOf.every(option => record(option) && typeof option.const === 'string' && nullableString(option.title))));
}
type McpElicitationPersistenceDecision = Extract<
  ApprovalDecision,
  "acceptForSession" | "acceptAlways"
>;

function mcpElicitationPersistenceDecision(
  value: string,
): McpElicitationPersistenceDecision | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("session")) return "acceptForSession";
  if (
    normalized.includes("always") ||
    normalized.includes("permanent") ||
    normalized.includes("forever") ||
    normalized.includes("persistent")
  ) {
    return "acceptAlways";
  }
  return null;
}

function mcpElicitationFormFields(payload: McpElicitationParams) {
  if (payload.mode === "url" || !isMcpElicitationForm(payload.requestedSchema)) {
    return undefined;
  }
  return payload.requestedSchema;
}

function mcpElicitationFieldOptions(field: McpFormField) {
  if (field.oneOf) {
    return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  }
  return (field.enum ?? []).map((value, index) => ({
    value,
    label: field.enumNames?.[index],
  }));
}

function isMcpElicitationPersistenceField(
  key: string,
  field: McpFormField,
): boolean {
  return (
    mcpElicitationPersistenceDecision(key) !== null ||
    key.toLowerCase() === "persist" ||
    mcpElicitationPersistenceDecision(field.title ?? "") !== null ||
    mcpElicitationPersistenceDecision(field.description ?? "") !== null
  );
}

export function describeMcpElicitation(
  payload: McpElicitationParams,
): { readonly appName: string; readonly options: ReadonlyArray<ApprovalOption> } {
  const metadata = isMcpElicitationMetadata(payload._meta) ? payload._meta : undefined;
  const appName =
    metadata?.app_name ??
    metadata?.appName ??
    metadata?.app ??
    metadata?.target?.app ??
    metadata?.target?.name ??
    metadata?.tool_params?.app_name ??
    metadata?.tool_params?.app ??
    payload.message.match(/^Allow ChatGPT to use (.+?)\?$/i)?.[1] ??
    metadata?.connector_name ??
    metadata?.connectorName ??
    payload.serverName;
  const persistenceOptions = new Map<McpElicitationPersistenceDecision, string>();
  const persist = metadata?.persist;
  for (const value of typeof persist === "string" ? [persist] : (persist ?? [])) {
    const decision = mcpElicitationPersistenceDecision(value);
    if (decision) persistenceOptions.set(decision, "");
  }
  if (metadata?.allowPersistentApproval) {
    persistenceOptions.set("acceptAlways", "");
  }

  const form = mcpElicitationFormFields(payload);
  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    for (const option of mcpElicitationFieldOptions(field)) {
      const decision = mcpElicitationPersistenceDecision(option.value);
      if (decision) persistenceOptions.set(decision, option.label ?? "");
    }
    if (field.type === "boolean" && isMcpElicitationPersistenceField(key, field)) {
      persistenceOptions.set("acceptAlways", field.title ?? "");
    }
  }

  return {
    appName,
    options: [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      ...(persistenceOptions.has("acceptForSession") &&
      toMcpElicitationResponse(payload, "acceptForSession").action === "accept"
        ? [
            {
              decision: "acceptForSession" as const,
              label: persistenceOptions.get("acceptForSession") || "Always allow this session",
            },
          ]
        : []),
      ...(persistenceOptions.has("acceptAlways") &&
      toMcpElicitationResponse(payload, "acceptAlways").action === "accept"
        ? [
            {
              decision: "acceptAlways" as const,
              label: persistenceOptions.get("acceptAlways") || "Always allow",
            },
          ]
        : []),
      { decision: "accept", label: "Approve" },
    ],
  };
}

export function toMcpElicitationResponse(
  payload: McpElicitationParams,
  decision: ApprovalDecision,
): McpElicitationResponse {
  if (decision === "decline" || decision === "cancel") {
    return { action: decision };
  }

  if (payload.mode === "url") {
    return { action: "decline" };
  }

  const persist =
    decision === "acceptForSession"
      ? "session"
      : decision === "acceptAlways"
        ? "always"
        : undefined;
  const form = mcpElicitationFormFields(payload);
  const content: Record<string, Json> = {};

  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    const options = mcpElicitationFieldOptions(field);
    const chosenOption = options.find((option) =>
      persist
        ? mcpElicitationPersistenceDecision(option.value) === decision
        : /once|accept|approve|allow/i.test(option.value) &&
          mcpElicitationPersistenceDecision(option.value) === null,
    );
    if (chosenOption) {
      content[key] = chosenOption.value;
    } else if (field.type === "boolean" && isMcpElicitationPersistenceField(key, field)) {
      content[key] = decision === "acceptAlways";
    } else if (field.default !== undefined && field.default !== null) {
      content[key] = field.default;
    }
  }

  if (form?.required?.some((key) => !Object.hasOwn(content, key))) {
    return { action: "decline" };
  }

  return {
    action: "accept",
    ...(persist ? { _meta: { persist } } : {}),
    ...(form ? { content } : {}),
  };
}
