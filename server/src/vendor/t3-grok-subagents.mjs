// Derived without semantic edits from pingdotgg/t3code@8cd9641f76874f2ce17d6c80acd71fab1f0b99d3
// packages/provider-grok/src/server/xaiAcpExtension.ts, pure subagent and background functions.
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
const XAI_TASK_COMPLETED_PROMPT_ID_PREFIX = "task-completed-";
export function isXAiTaskCompletedWakeNotification(notification) {
    const promptId = notification._meta?.promptId;
    return typeof promptId === "string" && promptId.startsWith(XAI_TASK_COMPLETED_PROMPT_ID_PREFIX);
}
function isXAiMonitorStartAck(output) {
    if (output === undefined)
        return false;
    return /monitor started\s*\(\s*task\s+/i.test(output);
}
export function isXAiMonitorTool(toolCall) {
    const title = titleKey(toolCall);
    if (title === "monitor" || title.startsWith("monitor "))
        return true;
    const rawInput = unknownRecord(toolCall.data.rawInput);
    const variant = nonEmptyString(rawInput?.variant)?.toLowerCase();
    if (variant === "monitor")
        return true;
    // Live start ACKs often keep a generic title ("Tool") and only mark the
    // structured envelope as Monitor; title rewrite to description must not
    // prevent monitor registration / inProgress forcing.
    const rawOutput = unknownRecord(toolCall.data.rawOutput);
    const outputType = nonEmptyString(rawOutput?.type)?.toLowerCase();
    if (outputType === "monitor")
        return true;
    // Released clients can wrap the start ACK as plain Text and omit the Monitor
    // variant. The ACK is still unambiguous and contains the task id required for
    // background tracking, even after a generic title is rewritten from
    // rawInput.description.
    return isXAiMonitorStartAck(xAiToolOutputText(toolCall));
}
function xAiBackgroundShellTaskId(toolCall) {
    const rawOutput = unknownRecord(toolCall.data.rawOutput);
    return nonEmptyString(rawOutput?.type) === "BackgroundTaskStarted"
        ? nonEmptyString(rawOutput?.task_id)
        : undefined;
}
export function extractXAiMonitorTaskId(toolCall) {
    const backgroundShellTaskId = xAiBackgroundShellTaskId(toolCall);
    if (backgroundShellTaskId !== undefined)
        return backgroundShellTaskId;
    if (!isXAiMonitorTool(toolCall))
        return undefined;
    const rawOutput = unknownRecord(toolCall.data.rawOutput);
    if (rawOutput !== undefined && nonEmptyString(rawOutput.type)?.toLowerCase() === "monitor") {
        const structured = nonEmptyString(rawOutput.taskId) ?? nonEmptyString(rawOutput.task_id);
        if (structured !== undefined)
            return structured;
    }
    const output = xAiToolOutputText(toolCall);
    if (output !== undefined) {
        const fromAck = firstUuidMatch(output, new RegExp(`monitor started\\s*\\(\\s*task\\s+(${XAI_UUID_RE})\\b`, "i"));
        if (fromAck !== undefined)
            return fromAck;
    }
    const rawInput = unknownRecord(toolCall.data.rawInput);
    return (nonEmptyString(rawInput?.task_id) ??
        nonEmptyString(rawInput?.taskId) ??
        (Array.isArray(rawInput?.task_ids) ? nonEmptyString(rawInput.task_ids[0]) : undefined));
}
export function isXAiPersistentMonitor(toolCall) {
    if (!isXAiMonitorTool(toolCall))
        return false;
    const rawOutput = unknownRecord(toolCall.data.rawOutput);
    if (rawOutput !== undefined && nonEmptyString(rawOutput.type)?.toLowerCase() === "monitor") {
        return rawOutput.persistent === true;
    }
    const rawInput = unknownRecord(toolCall.data.rawInput);
    return rawInput?.persistent === true;
}
export function extractXAiBackgroundTaskCompletion(toolCall) {
    const rawInput = unknownRecord(toolCall.data.rawInput);
    if (!isXAiGetSubagentOutputTool(toolCall, rawInput))
        return [];
    const text = xAiToolOutputText(toolCall);
    const status = statusFromGetOutputTool(toolCall, text);
    const appendOutput = resultFromGetOutputTool(toolCall, text) ?? "";
    // Prefer the completed identity from the result/header over the request list
    // (one call can poll multiple task_ids).
    const resultTaskId = resultTaskIdFromGetOutputTool(toolCall, text);
    if (resultTaskId !== undefined) {
        return [{ taskId: resultTaskId, status, appendOutput }];
    }
    const requestIds = [];
    const push = (value) => {
        const id = nonEmptyString(value);
        if (id !== undefined && new RegExp(`^${XAI_UUID_RE}$`, "i").test(id)) {
            requestIds.push(id);
        }
    };
    if (Array.isArray(rawInput?.task_ids)) {
        for (const entry of rawInput.task_ids)
            push(entry);
    }
    push(rawInput?.task_id);
    push(rawInput?.taskId);
    const unique = [...new Set(requestIds)];
    return unique.map((taskId) => ({ taskId, status, appendOutput }));
}
export function extractXAiKilledBackgroundTasks(toolCall) {
    const title = titleKey(toolCall);
    const rawInput = unknownRecord(toolCall.data.rawInput);
    const variant = nonEmptyString(rawInput?.variant)?.toLowerCase();
    if (!title.includes("kill_command_or_subagent") && variant !== "kill")
        return [];
    if (toolCall.status !== "completed")
        return [];
    const taskIds = [];
    const push = (value) => {
        const id = nonEmptyString(value);
        if (id !== undefined)
            taskIds.push(id);
    };
    if (Array.isArray(rawInput?.task_ids)) {
        for (const entry of rawInput.task_ids)
            push(entry);
    }
    push(rawInput?.task_id);
    push(rawInput?.taskId);
    return [...new Set(taskIds)].map((taskId) => ({
        taskId,
        status: "completed",
        appendOutput: "",
    }));
}
function xAiBackgroundTaskReport(update) {
    const snapshot = update.task_snapshot;
    const monitorDescription = nonEmptyString(update.monitor_description ?? undefined);
    const displayCommand = nonEmptyString(snapshot?.display_command ?? undefined);
    const isMonitor = snapshot?.kind === "monitor" ||
        monitorDescription !== undefined ||
        displayCommand?.startsWith("[monitor]") === true;
    // Grok's snapshot defaults `kind` to bash; anything that carries a command is one.
    const isCommand = snapshot?.kind === "bash" || snapshot?.command !== undefined || update.command !== undefined;
    if (!isMonitor && !isCommand)
        return undefined;
    const label = monitorDescription ??
        nonEmptyString(snapshot?.description ?? undefined) ??
        nonEmptyString(update.description ?? undefined) ??
        displayCommand?.replace(/^\[monitor\]\s*/, "") ??
        nonEmptyString(snapshot?.command) ??
        nonEmptyString(update.command);
    const named = label === undefined ? {} : { label };
    if (isMonitor)
        return { kind: "monitor", ...named };
    const exitCode = snapshot?.exit_code;
    return { kind: "command", ...named, ...(typeof exitCode === "number" ? { exitCode } : {}) };
}
export function xAiBackgroundTaskLifecycleMutation(notification, status) {
    const update = notification.update;
    const taskId = nonEmptyString(update.task_snapshot?.task_id) ??
        nonEmptyString(update.task_id) ??
        nonEmptyString(update.tool_call_id);
    if (taskId === undefined)
        return null;
    const exitCode = update.task_snapshot?.exit_code;
    const output = update.task_snapshot?.output;
    const report = xAiBackgroundTaskReport(update);
    return {
        sessionId: notification.sessionId,
        taskId,
        status: status === "completed" && typeof exitCode === "number" && exitCode !== 0 ? "failed" : status,
        ...(output === undefined ? {} : { output }),
        ...(report === undefined ? {} : { report }),
    };
}
export function extractXAiAcpBackgroundToolMutation(text) {
    const mutations = [];
    const eventRe = new RegExp(`<monitor-event\\s+task_id=["']?(${XAI_UUID_RE})["']?\\s*>\\s*([\\s\\S]*?)\\s*</monitor-event>`, "gi");
    for (const eventMatch of text.matchAll(eventRe)) {
        if (eventMatch[1] === undefined)
            continue;
        const line = (eventMatch[2] ?? "").trim();
        mutations.push({
            taskId: eventMatch[1],
            status: "running",
            appendOutput: line.length > 0 ? `${line}\n` : "",
        });
    }
    const batchedRe = new RegExp(`<monitor\\s[^>]*task_id=["']?(${XAI_UUID_RE})["']?[^>]*>\\s*([\\s\\S]*?)\\s*</monitor>`, "gi");
    for (const batchedMatch of text.matchAll(batchedRe)) {
        if (batchedMatch[1] === undefined)
            continue;
        const lines = (batchedMatch[2] ?? "").trim();
        mutations.push({
            taskId: batchedMatch[1],
            status: "running",
            appendOutput: lines.length > 0 ? `${lines}\n` : "",
        });
    }
    const endedRe = new RegExp(`Monitor\\s+["']?(${XAI_UUID_RE})["']?\\s+ended`, "gi");
    for (const endedMatch of text.matchAll(endedRe)) {
        if (endedMatch[1] === undefined)
            continue;
        // Only the "Monitor … ended …" clause is outcome text. Description/output
        // after the header can contain words like "error" without meaning failure.
        const outcomeClause = (endedMatch[0] ?? "").trim();
        const afterHeader = text.slice((endedMatch.index ?? 0) + endedMatch[0].length);
        const outcomeTail = afterHeader.split(/\n/)[0] ?? "";
        const outcome = `${outcomeClause}${outcomeTail}`;
        const summary = text.replace(/<\/?system-reminder>/gi, "").trim();
        mutations.push({
            taskId: endedMatch[1],
            status: /exited\s*\(\s*code\s*0\s*\)/i.test(outcome) || /ended cleanly/i.test(outcome)
                ? "completed"
                : /exited|failed|error|signal/i.test(outcome)
                    ? "failed"
                    : "completed",
            appendOutput: summary.length > 0 ? `${summary}\n` : "Monitor ended.\n",
        });
    }
    return mutations;
}
