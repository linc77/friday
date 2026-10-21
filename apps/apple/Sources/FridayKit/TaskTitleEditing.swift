import SwiftUI

@MainActor
final class TaskTitleRenaming: ObservableObject {
    @Published private(set) var state = TaskTitleRenameState()
    @Published private(set) var busy = false
    @Published var failure: String?
    private var operation = UUID()

    func begin(_ task: WorkItem, store: FridayStore) {
        guard !busy, store.connected, store.snapshotIdentity == store.connectionIdentity, task.localAgent else { return }
        failure = nil; state.begin(taskID: task.id, title: task.title, scope: store.connectionIdentity)
    }
    func change(_ value: String, token: UUID) { state.change(value, token: token) }
    func cancel() { state.cancel() }
    func reset() { state.cancel(); operation = UUID(); busy = false; failure = nil }
    func finish(_ token: UUID, store: FridayStore, cancelled: Bool = false) {
        guard let edit = state.edit else { return }
        guard let task = store.tasks.first(where: { $0.id == edit.taskID && $0.localAgent }) else { state.cancel(); return }
        guard let result = state.finish(token: token, scope: store.connectionIdentity, currentTitle: task.title, cancelled: cancelled) else { return }
        switch result {
        case .unchanged, .cancelled: return
        case .invalid(let message): failure = message
        case .save(let taskID, let title):
            guard store.connected else { failure = "主机未连接，请重新连接后再修改任务名称"; return }
            let scope = store.connectionIdentity; let connection = store.connection
            let operation = UUID(); self.operation = operation; busy = true
            Task { @MainActor in
                defer { if self.operation == operation { busy = false } }
                guard scope == store.connectionIdentity else { return }
                do {
                    _ = try await connection.data("/api/tasks/\(taskID)", method: "PATCH", body: ["title": title])
                    guard scope == store.connectionIdentity, self.operation == operation else { return }
                    await store.refresh()
                } catch {
                    if scope == store.connectionIdentity, self.operation == operation { failure = error.localizedDescription }
                }
            }
        }
    }
    func configuration(store: FridayStore) -> TaskTitleEditorConfiguration? {
        guard let edit = state.edit else { return nil }
        return TaskTitleEditorConfiguration(token: edit.id, text: Binding(get: { self.state.edit?.text ?? "" }, set: { self.change($0, token: edit.id) }),
            commit: { self.finish(edit.id, store: store) }, cancel: { self.finish(edit.id, store: store, cancelled: true) })
    }
}

struct TaskTitleEditorConfiguration {
    let token: UUID
    let text: Binding<String>
    let commit: () -> Void
    let cancel: () -> Void
}

#if os(macOS)
import AppKit

// The field editor owns IME composition, selection, undo and its I-beam cursor.
// A coordinator retires before the row changes, so Return/Escape followed by a
// blur cannot commit twice or write a newer editing session's title.
struct TaskTitleEditor: NSViewRepresentable {
    let configuration: TaskTitleEditorConfiguration
    @Environment(\.locale) private var locale
    func makeCoordinator() -> Coordinator { Coordinator(configuration) }
    func makeNSView(context: Context) -> Field {
        let field = Field()
        field.font = .systemFont(ofSize: 12); field.textColor = .labelColor
        field.isBordered = true; field.isBezeled = true; field.bezelStyle = .roundedBezel
        field.drawsBackground = true; field.backgroundColor = .controlBackgroundColor
        field.focusRingType = .default; field.isEditable = true; field.isSelectable = true
        field.usesSingleLineMode = true; field.lineBreakMode = .byClipping
        field.stringValue = configuration.text.wrappedValue
        field.delegate = context.coordinator; field.target = context.coordinator; field.action = #selector(Coordinator.submit(_:))
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return field
    }
    func updateNSView(_ field: Field, context: Context) {
        context.coordinator.configuration = configuration
        field.setAccessibilityLabel(String(localized: "任务名称", bundle: .module, locale: locale))
        if (field.currentEditor() as? NSTextView)?.hasMarkedText() != true, field.stringValue != configuration.text.wrappedValue {
            field.stringValue = configuration.text.wrappedValue
        }
    }
    static func dismantleNSView(_ field: Field, coordinator: Coordinator) {
        coordinator.finished = true; field.delegate = nil; field.target = nil
    }
    final class Field: NSTextField {
        private var needsInitialFocus = true
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil, needsInitialFocus else { return }
            needsInitialFocus = false
            DispatchQueue.main.async { [weak self] in
                guard let self, let window = self.window, self.delegate != nil else { return }
                window.makeFirstResponder(self); self.currentEditor()?.selectAll(nil)
            }
        }
    }
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var configuration: TaskTitleEditorConfiguration
        var finished = false
        init(_ configuration: TaskTitleEditorConfiguration) { self.configuration = configuration }
        func controlTextDidChange(_ notification: Notification) {
            guard !finished, let field = notification.object as? NSTextField else { return }
            configuration.text.wrappedValue = field.stringValue
        }
        private func complete(_ field: NSTextField, cancelled: Bool) {
            guard !finished else { return }; finished = true
            configuration.text.wrappedValue = field.stringValue
            if cancelled { configuration.cancel() } else { configuration.commit() }
        }
        @objc func submit(_ field: NSTextField) { complete(field, cancelled: false) }
        func controlTextDidEndEditing(_ notification: Notification) {
            if let field = notification.object as? NSTextField { complete(field, cancelled: false) }
        }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy command: Selector) -> Bool {
            guard !textView.hasMarkedText(), let field = control as? NSTextField else { return false }
            if command == #selector(NSResponder.insertNewline(_:)) { complete(field, cancelled: false); return true }
            if command == #selector(NSResponder.cancelOperation(_:)) { complete(field, cancelled: true); return true }
            return false
        }
    }
}

struct TaskSidebarTaskButton: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let selected: Bool
    let showsWorkspace: Bool
    let select: () -> Void
    let removed: () -> Void
    var dragPayload: TaskSidebarDragPayload? = nil
    var sidebarMovement: TaskSidebarMovement? = nil
    var bulk: TaskBulkMenuContext? = nil
    @StateObject private var rename = TaskTitleRenaming()

    private var row: some View {
        TaskRow(task: task, workspaceName: TaskWorkspaces.name(for: task, in: store.projects), workspace: TaskWorkspaces.project(for: task, in: store.projects),
            selected: selected, showsWorkspace: showsWorkspace, renaming: rename.configuration(store: store),
            acknowledgeWake: { Task { await store.acknowledgeTaskWake(task) } })
            .padding(.horizontal, TaskSidebarLayout.rowInset).foregroundStyle(.primary)
    }
    var body: some View {
        VStack(spacing: 0) {
            if rename.state.edit != nil {
                row.background(selected ? FridayTheme.surface : .clear, in: RoundedRectangle(cornerRadius: 10))
            } else {
                Button(action: select) { row }
                    .buttonStyle(TaskRowButtonStyle(selected: selected))
                    .simultaneousGesture(TapGesture(count: 2).onEnded {
                        guard NSEvent.modifierFlags.intersection([.command, .control, .shift, .option]).isEmpty else { return }
                        rename.begin(task, store: store)
                    })
                    .taskActions(store: store, task: task, onRename: { rename.begin(task, store: store) }, sidebarMovement: sidebarMovement, bulk: bulk, onRemoved: removed)
                    .modifier(TaskSidebarDragSource(payload: rename.busy ? nil : dragPayload))
                    .help("\(task.title)\n\(task.cwd)")
            }
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .modifier(TaskTitleKeyboardGuard(token: rename.state.edit?.id))
        .alert(Text(friday: "任务操作失败"), isPresented: Binding(get: { rename.failure != nil }, set: { if !$0 { rename.failure = nil } })) {
            Button(friday: "好") { rename.failure = nil }
        } message: { Text(fridayString: rename.failure ?? "") }
        .onChange(of: store.connectionIdentity) { _, _ in rename.reset() }
        .onDisappear { rename.cancel() }
    }
}

struct TaskHeaderTitle: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    @StateObject private var rename = TaskTitleRenaming()
    var body: some View {
        HStack(spacing: 0) {
            if let configuration = rename.configuration(store: store) {
                TaskTitleEditor(configuration: configuration).id(configuration.token).frame(minWidth: 120, idealWidth: 240, maxWidth: 360).frame(height: 22)
            } else {
                HStack(spacing: 6) {
                    Text(task.title).font(.callout.weight(.medium)).lineLimit(1)
                        .opacity(task.titleRegeneration == nil ? 1 : 0.55)
                        .help(task.titleRegeneration == nil ? Text(task.title) : Text(friday: "正在重新生成标题"))
                    FridaySymbolImage(systemName: "chevron.down").font(.system(size: 9)).foregroundStyle(.secondary)
                }.taskActions(store: store, task: task, opensMenu: true, onRename: { rename.begin(task, store: store) })
            }
        }
        .modifier(TaskTitleKeyboardGuard(token: rename.state.edit?.id))
        .alert(Text(friday: "任务操作失败"), isPresented: Binding(get: { rename.failure != nil }, set: { if !$0 { rename.failure = nil } })) {
            Button(friday: "好") { rename.failure = nil }
        } message: { Text(fridayString: rename.failure ?? "") }
        .onChange(of: store.connectionIdentity) { _, _ in rename.reset() }
        .onDisappear { rename.cancel() }
    }
}
#endif
