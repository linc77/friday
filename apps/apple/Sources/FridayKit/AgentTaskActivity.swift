import SwiftUI

// Follow T3 Code's Sidebar and WorkingTimelineRow. Keep the elapsed clock
// out of status announcements so screen readers do not announce every tick.
struct AgentTaskSidebarActivity: View {
    let task: WorkItem
    var acknowledgeWake: (() -> Void)? = nil

    private var label: String? {
        if task.pendingSubagentRequest != nil { return "Approval" }
        if task.forkBusy { return task.statusText }
        if task.preparingWorkspace != nil { return "准备工作区" }
        if task.watchingPullRequests && !task.active { return "正在自动跟进" }
        if task.backgroundWaiting == true, !task.approvals.contains(where: { $0.state == "pending" }) { return "等待后台任务" }
        return switch task.activityStatus {
        case "queued", "running": "Working"
        case "waiting": "Approval"
        case "failed": "Failed"
        case "interrupted": "待恢复"
        case "needs_project": "等你选择目录"
        default: nil
        }
    }

    private var symbol: String {
        if task.pendingSubagentRequest != nil { return "exclamationmark.shield" }
        if task.forkBusy { return "arrow.triangle.branch" }
        if task.watchingPullRequests && !task.active { return "eye" }
        if task.backgroundWaiting == true, !task.approvals.contains(where: { $0.state == "pending" }) { return "pause.circle" }
        return switch task.activityStatus {
        case "queued", "running": "circle.dashed"
        case "waiting": "exclamationmark.shield"
        case "failed": "exclamationmark.circle"
        case "interrupted": "pause.circle"
        default: "folder.badge.questionmark"
        }
    }

    private var color: Color {
        if task.pendingSubagentRequest != nil { return .orange }
        if task.forkBusy { return task.forkOperation?.running == true ? .blue : .orange }
        if task.watchingPullRequests && !task.active { return .secondary }
        if task.backgroundWaiting == true, !task.approvals.contains(where: { $0.state == "pending" }) { return .secondary }
        return switch task.activityStatus {
        case "queued", "running": Color(red: 59 / 255, green: 130 / 255, blue: 246 / 255)
        case "failed": .red
        default: .orange
        }
    }

    var body: some View {
        if let label {
            HStack(spacing: 4) {
                FridaySymbolImage(systemName: symbol)
                    .font(.system(size: 14)).frame(width: 16, height: 16)
                    .fridaySymbolFeedback(value: task.forkOperation?.status ?? task.activityStatus).accessibilityHidden(true)
                Text(fridayString: label).fontWeight(.medium)
                if task.pendingSubagentRequest == nil, task.preparingWorkspace == nil, task.activityStatus == "running" || task.activityStatus == "queued", let start = TaskRowPresentation.runningStart(task) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(AgentTaskTiming.sidebar(since: start, now: context.date))
                    }.accessibilityHidden(true)
                }
            }.foregroundStyle(color)
        } else if let wake = TaskSnooze.unseenWake(task) {
            if let acknowledgeWake {
                Button(action: acknowledgeWake) { wokeLabel }
                    .buttonStyle(TaskWakeButtonStyle()).fridayInteractiveCursor()
                    .help(Text(friday: "确认唤醒提醒"))
                    .accessibilityLabel(Text(friday: "确认唤醒提醒"))
            } else {
                wokeLabel.fridaySymbolFeedback(value: wake)
            }
        } else {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                Text(TaskRowPresentation.age(task, now: context.date))
            }.foregroundStyle(.secondary)
        }
    }

    private var wokeLabel: some View {
        HStack(spacing: 4) {
            FridaySymbolImage(systemName: "clock").font(.system(size: 12)).accessibilityHidden(true)
            Text(friday: "已唤醒").fontWeight(.medium)
        }.foregroundStyle(.orange)
    }
}

private struct TaskWakeButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.65 : 1)
            .fridaySymbolFeedback(active: configuration.isPressed)
    }
}

struct AgentTaskWorkingLine: View {
    let task: WorkItem

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 0) {
                if task.backgroundWaiting == true, !task.approvals.contains(where: { $0.state == "pending" }) {
                    Text(friday: "等待后台任务")
                } else if task.status == "waiting" {
                    Text(verbatim: "Pending Approval")
                } else if let start = TaskRowPresentation.runningStart(task) {
                    Text(verbatim: "Working for ")
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(AgentTaskTiming.transcript(since: start, now: context.date))
                    }.accessibilityHidden(true)
                } else {
                    Text(verbatim: "Working...")
                }
            }
            .font(.system(size: 14)).monospacedDigit().foregroundStyle(.secondary)
            .frame(minHeight: 24).padding(.horizontal, 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(fridayString: task.statusText))
            Divider()
        }.padding(.top, 4)
    }
}

private enum AgentTaskTiming {
    static func sidebar(since start: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    static func transcript(since start: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        if seconds < 60 { return "\(seconds)s" }
        var parts: [String] = []
        if seconds >= 3_600 { parts.append("\(seconds / 3_600)h") }
        if (seconds % 3_600) / 60 > 0 { parts.append("\((seconds % 3_600) / 60)m") }
        if seconds % 60 > 0 { parts.append("\(seconds % 60)s") }
        return parts.joined(separator: " ")
    }
}
