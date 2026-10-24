// Derived without semantic edits from pingdotgg/t3code@8cd9641f76874f2ce17d6c80acd71fab1f0b99d3
// packages/provider-grok/src/server/xaiAcpExtension.ts, pure subagent functions.
// MIT Copyright (c) 2026 T3 Tools Inc. Full license: ../../../vendor/t3code/LICENSE.
const XAI_UUID_RE = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";

function unknownRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function nonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function titleKey(toolCall) {
    return (toolCall.title ?? "").trim().toLowerCase();
}

function decodeByteText(value) {
    if (typeof value === "string")
        return nonEmptyString(value);
    if (!Array.isArray(value))
        return undefined;
    if (value.length === 0)
        return undefined;
    if (!value.every((entry) => typeof entry === "number"))
        return undefined;
    try {
        return nonEmptyString(new TextDecoder().decode(Uint8Array.from(value)));
    }
    catch {
        return undefined;
    }
}

function xAiToolOutputText(toolCall) {
    const rawOutput = unknownRecord(toolCall.data.rawOutput);
    if (rawOutput !== undefined) {
        const direct = nonEmptyString(rawOutput.text) ??
            nonEmptyString(rawOutput.output_for_prompt) ??
            decodeByteText(rawOutput.output);
        if (direct !== undefined)
            return direct;
        const result = unknownRecord(rawOutput.Result) ?? unknownRecord(rawOutput.result);
        if (result !== undefined) {
            const nested = nonEmptyString(result.output) ??
                nonEmptyString(result.text) ??
                decodeByteText(result.output);
            if (nested !== undefined)
                return nested;
        }
    }
    if (typeof toolCall.data.rawOutput === "string") {
        return nonEmptyString(toolCall.data.rawOutput);
    }
    const content = toolCall.data.content;
    if (!Array.isArray(content))
        return undefined;
    const text = content
        .flatMap((entry) => {
        const record = unknownRecord(entry);
        const nested = unknownRecord(record?.content);
        return nonEmptyString(nested?.text) ?? nonEmptyString(record?.text) ?? [];
    })
        .join("\n")
        .trim();
    return text.length > 0 ? text : undefined;
}

function firstUuidMatch(text, pattern) {
    const match = pattern.exec(text);
    return match?.[1];
}

function extractXAiChildSessionId(output) {
    if (output === undefined)
        return null;
    return (firstUuidMatch(output, new RegExp(`(?:^|\\n)\\s*Agent ID:\\s*(${XAI_UUID_RE})\\b`, "i")) ??
        firstUuidMatch(output, new RegExp(`(?:^|\\n)\\s*subagent_id:\\s*(${XAI_UUID_RE})\\b`, "i")) ??
        firstUuidMatch(output, new RegExp(`===\\s*Task\\s+(${XAI_UUID_RE})\\s*===`, "i")) ??
        null);
}

function isXAiAsyncSpawnAck(output) {
    if (output === undefined)
        return false;
    if (/subagent started in background/i.test(output))
        return true;
    return (new RegExp(`subagent_id:\\s*${XAI_UUID_RE}`, "i").test(output) &&
        /get_command_or_subagent_output/i.test(output));
}

function isXAiSpawnOrTaskTool(toolCall, rawInput) {
    const title = titleKey(toolCall);
    if (title === "task" || title === "spawn_subagent" || title.includes("spawn subagent")) {
        return true;
    }
    const variant = nonEmptyString(rawInput?.variant)?.toLowerCase();
    if (variant === "cursortask" || variant === "task" || variant === "spawn_subagent") {
        return true;
    }
    if (nonEmptyString(rawInput?.subagent_type) !== undefined)
        return true;
    if (nonEmptyString(rawInput?.subagentType) !== undefined)
        return true;
    return false;
}

function isXAiGetSubagentOutputTool(toolCall, rawInput) {
    const title = titleKey(toolCall);
    if (title === "get_command_or_subagent_output" ||
        title.includes("get_command_or_subagent_output") ||
        title === "wait_commands_or_subagents") {
        return true;
    }
    const variant = nonEmptyString(rawInput?.variant)?.toLowerCase();
    if (variant === "taskoutput" || variant === "task_output")
        return true;
    const rawOutput = unknownRecord(toolCall.data.rawOutput);
    const outputType = nonEmptyString(rawOutput?.type)?.toLowerCase();
    if (outputType === "taskoutput" || outputType === "task_output")
        return true;
    if (title.startsWith("[subagent:") && Array.isArray(rawInput?.task_ids))
        return true;
    return false;
}

function stripLeadingBalancedParenGroup(text) {
    const trimmed = text.replace(/^\s+/, "");
    if (!trimmed.startsWith("("))
        return trimmed;
    let depth = 0;
    for (let index = 0; index < trimmed.length; index += 1) {
        const char = trimmed[index];
        if (char === "(")
            depth += 1;
        else if (char === ")") {
            depth -= 1;
            if (depth === 0)
                return trimmed.slice(index + 1).replace(/^\s+/, "");
        }
    }
    return trimmed;
}

export function extractXAiAcpSubagentEndNotice(text) {
    const match = text.match(new RegExp(`Background subagent\\s+["']?(${XAI_UUID_RE})["']?`, "i"));
    if (match?.[1] === undefined)
        return undefined;
    // Skip the parenthesized descriptor (subagent type and title) so its words
    // cannot masquerade as the outcome verb. Balance parens so nested titles
    // like `(general-purpose: "Check (backend) failed")` do not leak.
    const tail = stripLeadingBalancedParenGroup(text.slice((match.index ?? 0) + match[0].length));
    if (/completed successfully/i.test(tail)) {
        return { childSessionId: match[1], status: "completed" };
    }
    if (/\b(failed|errored|error|crashed|cancelled|canceled|interrupted|timed out)\b/i.test(tail)) {
        return { childSessionId: match[1], status: "failed" };
    }
    if (/\b(completed|finished|ended)\b/i.test(tail)) {
        return { childSessionId: match[1], status: "completed" };
    }
    return undefined;
}

function taskIdsFromGetOutputTool(toolCall, rawInput) {
    const ids = [];
    const push = (value) => {
        const text = nonEmptyString(value);
        if (text !== undefined && new RegExp(`^${XAI_UUID_RE}$`, "i").test(text)) {
            ids.push(text);
        }
    };
    if (Array.isArray(rawInput?.task_ids)) {
        for (const entry of rawInput.task_ids)
            push(entry);
    }
    push(rawInput?.task_id);
    push(rawInput?.taskId);
    const resultId = resultTaskIdFromGetOutputTool(toolCall, xAiToolOutputText(toolCall));
    if (resultId !== undefined)
        ids.push(resultId);
    return [...new Set(ids)];
}

function resultTaskIdFromGetOutputTool(toolCall, output) {
    const rawOutput = unknownRecord(toolCall.data.rawOutput);
    const result = unknownRecord(rawOutput?.Result) ?? unknownRecord(rawOutput?.result);
    const structured = nonEmptyString(result?.task_id) ??
        nonEmptyString(result?.taskId) ??
        nonEmptyString(rawOutput?.task_id) ??
        nonEmptyString(rawOutput?.taskId);
    if (structured !== undefined && new RegExp(`^${XAI_UUID_RE}$`, "i").test(structured)) {
        return structured;
    }
    if (output === undefined)
        return undefined;
    const taskHeader = firstUuidMatch(output, new RegExp(`===\\s*Task\\s+(${XAI_UUID_RE})\\s*===`, "i"));
    return taskHeader;
}

function resultFromGetOutputTool(toolCall, output) {
    const rawOutput = unknownRecord(toolCall.data.rawOutput);
    const result = unknownRecord(rawOutput?.Result) ?? unknownRecord(rawOutput?.result);
    const structured = nonEmptyString(result?.output) ??
        nonEmptyString(result?.text) ??
        decodeByteText(result?.output);
    if (structured !== undefined) {
        const cleaned = structured
            .replace(/<subagent_meta>[\s\S]*?<\/subagent_meta>/gi, "")
            .replace(/<subagent_result>[\s\S]*?<\/subagent_result>/gi, "")
            .trim();
        if (cleaned.length > 0)
            return cleaned;
        return null;
    }
    if (output === undefined)
        return null;
    const marker = output.match(/=== Output ===\s*([\s\S]*)$/i);
    const body = (marker?.[1] ?? output).trim();
    return body.length > 0 ? body : null;
}

function statusFromGetOutputTool(toolCall, output) {
    if (toolCall.status === "failed")
        return "failed";
    const rawOutput = unknownRecord(toolCall.data.rawOutput);
    const result = unknownRecord(rawOutput?.Result) ?? unknownRecord(rawOutput?.result);
    const structuredStatus = nonEmptyString(result?.status)?.toLowerCase();
    if (structuredStatus === "completed" || structuredStatus === "success")
        return "completed";
    if (structuredStatus === "failed" || structuredStatus === "error")
        return "failed";
    if (structuredStatus === "running" || structuredStatus === "pending")
        return "running";
    if (typeof result?.exit_code === "number") {
        return result.exit_code === 0 ? "completed" : "failed";
    }
    if (output !== undefined) {
        if (/Status:\s*failed/i.test(output) || /Exit Code:\s*-?(?!0\b)\d+/i.test(output)) {
            return "failed";
        }
        if (/Status:\s*completed/i.test(output) || /Status:\s*success/i.test(output)) {
            return "completed";
        }
        if (/Status:\s*running/i.test(output) || /Status:\s*pending/i.test(output)) {
            return "running";
        }
    }
    // A completed get_output tool call only means the poll RPC returned. Without
    // a task-level terminal status or exit code, the requested task is still
    // running and must remain registered for subsequent polling.
    return "running";
}

export function extractXAiAcpSubagentUpdate(toolCall) {
    const rawInput = unknownRecord(toolCall.data.rawInput);
    const output = xAiToolOutputText(toolCall);
    if (isXAiGetSubagentOutputTool(toolCall, rawInput)) {
        const taskIds = taskIdsFromGetOutputTool(toolCall, rawInput);
        const childSessionId = resultTaskIdFromGetOutputTool(toolCall, output) ??
            taskIds[0] ??
            extractXAiChildSessionId(output);
        if (childSessionId === null)
            return undefined;
        return {
            nativeTaskId: toolCall.toolCallId,
            prompt: "",
            title: null,
            model: null,
            status: statusFromGetOutputTool(toolCall, output),
            childSessionId,
            result: resultFromGetOutputTool(toolCall, output),
            suppressNormalTool: true,
        };
    }
    if (!isXAiSpawnOrTaskTool(toolCall, rawInput))
        return undefined;
    const childSessionId = extractXAiChildSessionId(output);
    const asyncSpawnAck = isXAiAsyncSpawnAck(output);
    const legacyResult = output
        ?.replace(new RegExp(`(?:^|\\n)\\s*Agent ID:\\s*${XAI_UUID_RE}[^\\n]*(?:\\n|$)`, "gi"), "\n")
        .replace(new RegExp(`(?:^|\\n)\\s*subagent_id:\\s*${XAI_UUID_RE}[^\\n]*(?:\\n|$)`, "gi"), "\n")
        .trim() || null;
    let status;
    if (toolCall.status === "failed") {
        status = "failed";
    }
    else if (asyncSpawnAck) {
        status = "running";
    }
    else if (toolCall.status === "completed") {
        status = "completed";
    }
    else {
        status = "running";
    }
    return {
        nativeTaskId: toolCall.toolCallId,
        prompt: nonEmptyString(rawInput?.prompt) ?? "",
        title: nonEmptyString(rawInput?.description) ?? null,
        model: nonEmptyString(rawInput?.model) ?? null,
        status,
        childSessionId,
        result: asyncSpawnAck ? null : legacyResult,
        suppressNormalTool: true,
    };
}

function trimmed(value) {
    const text = value?.trim();
    return text && text.length > 0 ? text : undefined;
}