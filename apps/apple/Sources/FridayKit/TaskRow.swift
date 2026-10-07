import SwiftUI
#if os(macOS)
import AppKit
#endif

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

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
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
                title
            }.frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 16)

            HStack(spacing: TaskSidebarLayout.iconSpacing) {
                if task.git?.isWorktree == true {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .fridaySymbolFeedback(value: task.git?.isWorktree)
                        .accessibilityLabel("Git Worktree").help("Git Worktree")
                }
                Text(fridayString: TaskRowPresentation.branch(task.git))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                    .help(TaskRowPresentation.branch(task.git))
                Spacer(minLength: 6)
                TaskRowActivity(task: task).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading).frame(height: 16)
            .padding(.leading, TaskSidebarLayout.titleInset)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityValue(Text(task.agentName) + Text("，") + Text(fridayString: task.statusText))
    }

    private var title: some View {
        TaskRowTitle(title: task.title)
            .font(.system(size: 12))
            .foregroundStyle(.primary)
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
            .modifier(SidebarRowPointer())
            .onHover { hovering = $0 }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { hovering = false }
            }
            .onDisappear { hovering = false }
    }
}

private struct SidebarRowPointer: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled

    @ViewBuilder func body(content: Content) -> some View {
        #if os(macOS)
        if #available(macOS 15.0, *) {
            content.pointerStyle(isEnabled ? .link : nil)
        } else {
            content.background(TaskRowCursorRegion(enabled: isEnabled))
        }
        #else
        content
        #endif
    }
}

#if os(macOS)
/// AppKit owns the cursor's lifetime on macOS 14, including scrolling a row
/// out of view or removing it when a Workspace is collapsed.
private struct TaskRowCursorRegion: NSViewRepresentable {
    let enabled: Bool

    func makeNSView(context: Context) -> TaskRowCursorView { TaskRowCursorView() }

    func updateNSView(_ view: TaskRowCursorView, context: Context) {
        view.enabled = enabled
        view.window?.invalidateCursorRects(for: view)
    }
}

private final class TaskRowCursorView: NSView {
    var enabled = true

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func resetCursorRects() {
        super.resetCursorRects()
        if enabled { addCursorRect(visibleRect, cursor: .pointingHand) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.invalidateCursorRects(for: self)
    }
}
#endif

private struct TaskRowActivity: View {
    let task: WorkItem

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
            if task.status == "completed" {
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
