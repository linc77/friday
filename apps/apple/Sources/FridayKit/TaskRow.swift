import SwiftUI

enum TaskSidebarLayout {
    static let listInset: CGFloat = 6
    static let rowInset: CGFloat = 10
    static let iconSize: CGFloat = 16
    static let iconSpacing: CGFloat = 6
    static let titleInset = iconSize + iconSpacing
}

struct TaskRow: View {
    let task: WorkItem
    let workspaceName: String
    var workspace: Project? = nil
    var selected = false
    var showsWorkspace = true
    var renaming: TaskTitleEditorConfiguration? = nil
    var acknowledgeWake: (() -> Void)? = nil

    private var showsGitMetadata: Bool { task.git?.status == "repository" }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if showsWorkspace {
                HStack(spacing: TaskSidebarLayout.iconSpacing) {
                    WorkspaceIcon(name: workspaceName, icon: workspace?.icon, color: workspace?.color, size: TaskSidebarLayout.iconSize)
                    Text(fridayString: workspaceName).foregroundStyle(.primary).lineLimit(1)
                    Spacer(minLength: 6)
                }
                .font(.system(size: 12)).foregroundStyle(.secondary)
            }

            HStack(spacing: TaskSidebarLayout.iconSpacing) {
                AgentProviderIcon(provider: task.agent, size: 14)
                    .frame(width: TaskSidebarLayout.iconSize, height: TaskSidebarLayout.iconSize)
                    .foregroundStyle(.secondary)
                    .help(task.agentName)
                title.opacity(task.titleRegeneration == nil || renaming != nil ? 1 : 0.55)
                    .help(task.titleRegeneration == nil ? Text(task.title) : Text(friday: "正在重新生成标题"))
                if task.pinnedAt != nil {
                    FridaySymbolImage(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(.secondary)
                        .accessibilityLabel(Text(friday: "已置顶"))
                }
                if task.unread == true {
                    FridaySymbolImage(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(.blue)
                        .accessibilityLabel(Text(friday: "未读"))
                }
                if let activity = task.backgroundActivity, activity.total > 0 {
                    let count = activity.total
                    HStack(spacing: 3) {
                        FridaySymbolImage(systemName: activity.commands == count ? "terminal" : "square.stack").font(.system(size: 10)).accessibilityHidden(true)
                        Text(verbatim: String(count)).font(.system(size: 10)).monospacedDigit()
                    }.foregroundStyle(.secondary).accessibilityLabel(Text(friday: "后台工作")).fridaySymbolFeedback(value: count)
                }
                if let badge = TaskPullRequestPresentation.badge(task.pullRequests ?? [], stacks: task.changeRequestStacks ?? [:], branch: task.branchPullRequest) {
                    HStack(spacing: 3) {
                        FridaySymbolImage(systemName: badge.stacked ? "square.stack" : badge.state == "merged" ? "arrow.triangle.merge" : badge.state == "closed" ? "xmark.circle" : "arrow.triangle.pull").font(.system(size: 10))
                        Text(badge.stacked ? String(badge.count) : "#\(badge.current.number)").font(.system(size: 10)).monospacedDigit()
                    }.foregroundStyle(badge.state == "merged" ? Color.purple : badge.state == "open" ? Color.green : Color.secondary).help(badge.current.title)
                }
                if !showsGitMetadata {
                    TaskRowActivity(task: task, acknowledgeWake: acknowledgeWake).foregroundStyle(.secondary)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 16)

            if showsGitMetadata {
                HStack(spacing: TaskSidebarLayout.iconSpacing) {
                    if task.git?.isWorktree == true {
                        WorktreeIcon(size: 11)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Git Worktree").help("Git Worktree")
                    }
                    Text(fridayString: TaskRowPresentation.branch(task.git))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                        .help(TaskRowPresentation.branch(task.git))
                    Spacer(minLength: 6)
                    TaskRowActivity(task: task, acknowledgeWake: acknowledgeWake).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading).frame(height: 16)
                .padding(.leading, TaskSidebarLayout.titleInset)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: renaming == nil ? .combine : .contain)
        .accessibilityValue(Text(task.agentName) + Text("，") + Text(fridayString: task.statusText) + (task.titleRegeneration == nil ? Text("") : Text("，") + Text(friday: "正在重新生成标题")))
    }

    @ViewBuilder private var title: some View {
        #if os(macOS)
        if let renaming {
            TaskTitleEditor(configuration: renaming).id(renaming.token).frame(height: 20)
        } else { TaskRowTitle(title: task.title).font(.system(size: 12)).foregroundStyle(.primary) }
        #else
        TaskRowTitle(title: task.title).font(.system(size: 12)).foregroundStyle(.primary)
        #endif
    }
}

private struct TaskRowHoveredKey: EnvironmentKey {
    static let defaultValue = false
}

private extension EnvironmentValues {
    var taskRowHovered: Bool {
        get { self[TaskRowHoveredKey.self] }
        set { self[TaskRowHoveredKey.self] = newValue }
    }
}

private struct TaskRowTitle: View {
    let title: String
    @Environment(\.taskRowHovered) private var hovering
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var availableWidth: CGFloat = 0
    @State private var textWidth: CGFloat = 0
    @State private var offset: CGFloat = 0
    @State private var revealing = false

    private struct ScrollRequest: Equatable {
        let title: String
        let distance: CGFloat
    }

    private var request: ScrollRequest {
        let overflow = textWidth - availableWidth
        return ScrollRequest(title: title, distance: hovering && !reduceMotion && availableWidth > 0 && overflow > 1 ? overflow : 0)
    }

    var body: some View {
        Text(title)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { availableWidth = $0 }
            .opacity(revealing ? 0 : 1)
            .overlay(alignment: .leading) {
                // Measure and move the full title without changing the row's layout.
                Text(title)
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { textWidth = $0 }
                    .offset(x: offset)
                    .opacity(revealing ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .clipped()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(title))
            .task(id: request) {
                reset()
                let distance = request.distance
                guard distance > 0 else { return }
                do { try await Task.sleep(for: .milliseconds(800)) } catch { return }
                guard !Task.isCancelled else { return }
                revealing = true
                withAnimation(.linear(duration: Double(distance / 24))) { offset = -distance }
            }
            .onDisappear { reset() }
    }

    private func reset() {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            offset = 0
            revealing = false
        }
    }
}

struct TaskRowButtonStyle: ButtonStyle {
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        SidebarRowButtonBody(configuration: configuration, selected: selected)
    }
}

struct WorkspaceTitleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        SidebarRowButtonBody(configuration: configuration, selected: false)
            .fridaySymbolFeedback(active: configuration.isPressed)
    }
}

private struct SidebarRowButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast

    private var highlighted: Bool { hovering && isEnabled && scenePhase == .active }

    var body: some View {
        configuration.label
            .environment(\.taskRowHovered, highlighted)
            .background {
                let card = RoundedRectangle(cornerRadius: 10)
                card.fill(FridayTheme.surface.opacity(selected || configuration.isPressed ? 1 : highlighted ? 0.8 : 0))
                    .overlay {
                        card.strokeBorder(Color.primary.opacity(highlighted ? (contrast == .increased ? 0.3 : 0.06) : 0), lineWidth: 1)
                    }
                    .shadow(color: .black.opacity(highlighted ? (colorScheme == .dark ? 0.25 : 0.08) : 0),
                            radius: configuration.isPressed ? 2 : 5, x: 0, y: configuration.isPressed ? 1 : 2)
            }
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .fridayInteractiveCursor()
            .onHover { hovering = $0 }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { hovering = false }
            }
            .onDisappear { hovering = false }
    }
}

private struct TaskRowActivity: View {
    let task: WorkItem
    let acknowledgeWake: (() -> Void)?

    private var color: Color {
        switch task.status {
        case "running": .blue
        case "failed": .red
        case "waiting", "interrupted", "needs_project": .orange
        default: .secondary
        }
    }

    var body: some View {
        Group {
            if task.localAgent {
                AgentTaskSidebarActivity(task: task, acknowledgeWake: acknowledgeWake)
            } else if task.status == "completed" {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(TaskRowPresentation.age(task, now: context.date))
                }
            } else {
                HStack(spacing: 4) {
                    FridayTaskStatusIcon(status: task.status).frame(width: 12, height: 12)
                    Text(fridayString: task.statusText)
                    if task.status == "running", let start = TaskRowPresentation.runningStart(task) {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(TaskRowPresentation.elapsed(since: start, now: context.date))
                        }
                    }
                }.foregroundStyle(color)
            }
        }
        .font(.system(size: 12)).monospacedDigit().fixedSize(horizontal: true, vertical: false)
    }
}
