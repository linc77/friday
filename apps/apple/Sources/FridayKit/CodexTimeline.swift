import SwiftUI

struct CodexTimeline: View {
    let task: WorkItem
    var canOpenLocalFiles = false
    var body: some View {
        let rows = CodexTranscript.rows(task)
        let currentWorkId = rows.first { row in
            if task.status != "queued", case .work(let events) = row.content {
                return events.contains { $0.turnId != nil && $0.turnId == task.turnId }
            }
            return false
        }?.id
        ForEach(rows) { row in
            if task.active && row.id == currentWorkId { AgentTaskWorkingLine(task: task) }
            switch row.content {
            case .user(let text):
                HStack {
                    Spacer(minLength: 48)
                    Text(verbatim: text).font(.body).lineSpacing(5).textSelection(.enabled)
                        .padding(.horizontal, 18).padding(.vertical, 14)
                        .background(.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 16))
                }.id(row.id)
            case .reply(let text):
                CodexReply(text: text, canOpenLocalFiles: canOpenLocalFiles).id(row.id)
            case .work(let events):
                CodexWorkLog(events: events, task: task, canOpenLocalFiles: canOpenLocalFiles).id(row.id)
            }
        }
        if task.active && currentWorkId == nil { AgentTaskWorkingLine(task: task) }
    }
}

private struct CodexReply: View {
    let text: String
    let canOpenLocalFiles: Bool
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            AgentMarkdown(text: text, canOpenLocalFiles: canOpenLocalFiles)
            Button { copyAgentText(text); copied = true } label: {
                FridaySymbolLabel(friday: copied ? "已复制" : "复制回答", systemImage: copied ? "checkmark" : "doc.on.doc")
            }.font(.caption).foregroundStyle(.secondary).buttonStyle(FridaySymbolButtonStyle())
        }.onChange(of: text) { _, _ in copied = false }
    }
}

private struct CodexWorkLog: View {
    let events: [TaskEvent]
    let task: WorkItem
    let canOpenLocalFiles: Bool
    @State private var expanded: Bool? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var active: Bool { task.active && task.status != "queued" && events.contains { $0.turnId == task.turnId && $0.turnId != nil } }
    private var open: Bool { expanded ?? active }
    private var failed: Bool { events.contains { ["failed", "declined", "interrupted"].contains($0.status ?? "") } }
    private var commandCount: Int { events.filter { $0.kind == "command" }.count }
    private var fileCount: Int { events.filter { $0.kind == "files" }.count }
    private var title: LocalizedStringKey {
        if let seconds = CodexTranscript.duration(events, task: task) {
            return seconds < 60 ? "处理了 \(seconds) 秒" : "处理了 \(seconds / 60) 分 \(seconds % 60) 秒"
        }
        return "处理过程"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !active {
                Button { expanded = !open } label: {
                    HStack(spacing: 9) {
                        Text(friday: title)
                        FridaySymbolImage(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .medium))
                        Spacer(minLength: 8)
                        if commandCount > 0 { Text(friday: "\(commandCount) 个命令").font(.caption) }
                        if fileCount > 0 { Text(friday: "\(fileCount) 次文件改动").font(.caption) }
                        if failed { FridaySymbolImage(systemName: "exclamationmark.circle").foregroundStyle(.orange) }
                    }.contentShape(Rectangle())
                }.buttonStyle(FridaySymbolButtonStyle()).font(.callout).foregroundStyle(.secondary)
                    .accessibilityLabel(Text(friday: open ? "收起处理过程" : "展开处理过程"))
                    .accessibilityValue(Text(friday: open ? "已展开" : "已收起"))
            }
            if active || open {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(events) { event in
                        if event.kind == "message" {
                            AgentMarkdown(text: event.text, compact: true, canOpenLocalFiles: canOpenLocalFiles)
                        } else { CodexToolRow(event: event) }
                    }
                }.padding(.leading, 4)
            }
            if !active { Divider() }
        }
        // Only the fold animates. Streaming text never animates its layout.
        .animation(reduceMotion ? nil : FridayTheme.motion, value: open)
    }
}

private struct CodexToolRow: View {
    let event: TaskEvent
    @State private var expanded = false
    private var symbol: String {
        switch event.kind {
        case "command": "terminal"
        case "files": "doc.text"
        case "search": "magnifyingglass"
        case "reasoning": "sparkle"
        case "plan": "checklist"
        case "image": "photo"
        default: "wrench.and.screwdriver"
        }
    }
    private var title: String {
        if event.kind == "files" && event.itemId != nil {
            return event.text.components(separatedBy: "\n").map { ($0 as NSString).lastPathComponent }.joined(separator: " · ")
        }
        if event.kind == "files" { return "文件改动" }
        if event.kind == "reasoning" { return "思考摘要" }
        if event.kind == "plan" { return "执行计划" }
        return event.text.components(separatedBy: "\n").first ?? event.text
    }
    private var detail: String {
        if event.kind == "command" && event.itemId != nil {
            var value = event.text
            if let output = event.detail, !output.isEmpty { value += "\n\n" + output }
            if let exit = event.exitCode { value += "\n\n退出码：\(exit)" }
            return value
        }
        return event.detail?.isEmpty == false ? event.detail! : event.text
    }
    private var status: String {
        switch event.status {
        case "running": "进行中"
        case "failed": "失败"
        case "declined": "已拒绝"
        case "interrupted": "已中断"
        default: ""
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 10) {
                    FridaySymbolImage(systemName: symbol).frame(width: 16).fridaySymbolFeedback(value: event.status)
                    Text(fridayString: title).font(event.kind == "command" ? .system(.callout, design: .monospaced) : .callout)
                        .lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    if !status.isEmpty { Text(fridayString: status).font(.caption).foregroundStyle(event.status == "running" ? Color.secondary : .orange) }
                    FridaySymbolImage(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 10))
                }.contentShape(Rectangle())
            }.buttonStyle(FridaySymbolButtonStyle()).foregroundStyle(.secondary)
                .accessibilityLabel(Text(friday: expanded ? "收起执行项" : "展开执行项") + Text(verbatim: "，" + title))
            if expanded {
                if ["command", "files"].contains(event.kind) { AgentCodeBlock(language: event.kind == "command" ? "Terminal" : "Diff", text: detail) }
                else { AgentMarkdown(text: detail, compact: true) }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
