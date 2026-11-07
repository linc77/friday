import SwiftUI

struct TaskSearchControl: View {
    @ObservedObject var store: FridayStore
    var scope: String? = nil
    var projectIDs: Set<String>? = nil
    var presented: Binding<Bool>? = nil
    let openTask: (String) -> Void
    @State private var ownPresentation = false
    @Environment(\.locale) private var locale
    private var showing: Binding<Bool> { presented ?? $ownPresentation }
    var body: some View {
        Button { showing.wrappedValue.toggle() } label: {
            FridaySymbolImage(systemName: "magnifyingglass").font(.system(size: 16)).frame(width: 32, height: 32)
        }.buttonStyle(FridaySymbolButtonStyle())
            .accessibilityLabel(Text(friday: "搜索任务"))
            .help(Text(friday: "搜索任务标题、PR 或消息"))
            .popover(isPresented: showing) {
                TaskSearchPanel(store: store, scope: scope, projectIDs: projectIDs, dismiss: { showing.wrappedValue = false }) { id in
                    showing.wrappedValue = false; openTask(id)
                }.environment(\.locale, locale).id(store.connectionIdentity)
            }
            .onChange(of: store.connectionIdentity) { _, _ in showing.wrappedValue = false }
    }
}

private struct TaskSearchPanel: View {
    @ObservedObject var store: FridayStore
    let scope: String?
    var projectIDs: Set<String>? = nil
    let dismiss: () -> Void
    let openTask: (String) -> Void
    @State private var query = ""
    @State private var state = TaskSearchState()
    @State private var selected: String?
    @State private var attempt = 0
    #if os(iOS)
    @FocusState private var focused: Bool
    #endif
    private struct RequestKey: Equatable { let query: String; let scope: String; let session: String?; let connected: Bool; let attempt: Int }
    private var scopeKey: String { store.connectionIdentity + "\nsearch:" + (scope ?? "*") + "\n" + (projectIDs?.sorted().joined(separator: "\n") ?? "*") }
    private var normalized: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var requestKey: RequestKey { RequestKey(query: normalized, scope: scopeKey, session: store.taskStreamSession, connected: store.connected, attempt: attempt) }
    private var tasks: [WorkItem] {
        guard store.snapshotIdentity == store.connectionIdentity else { return [] }
        guard let projectIDs else { return store.tasks }
        return store.tasks.filter { task in let project = TaskWorkspaces.project(for: task, in: store.projects); return project.map { projectIDs.contains($0.id) } ?? (projectIDs.isEmpty && task.projectId == nil) }
    }
    private var results: [TaskSearchPresentation.Result] {
        TaskSearchPresentation.results(tasks: tasks, projects: store.projects, scope: scope, query: query,
            matches: state.currentMatches(query, scope: scopeKey, session: store.taskStreamSession), now: .now)
    }
    private var highlighted: String? { selected.flatMap { id in results.contains { $0.id == id } ? id : nil } ?? results.first?.id }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(friday: "搜索任务").font(.headline)
                Spacer()
                if let project = store.projects.first(where: { $0.id == scope }) { Text(verbatim: project.name).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }.padding([.horizontal, .top], 16).padding(.bottom, 10)
            #if os(macOS)
            TaskSearchField(text: $query, move: move, submit: choose, escape: escape).frame(height: 28).padding(.horizontal, 14).padding(.bottom, 12)
            #else
            TextField(friday: "搜索任务标题、PR 或消息…", text: $query).textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search).focused($focused)
                .onSubmit { _ = choose() }.padding(.horizontal, 14).padding(.bottom, 12)
            #endif
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 3) {
                        ForEach(results) { result in resultRow(result).id(result.id) }
                        if results.isEmpty {
                            Text(fridayString: normalized.isEmpty ? "输入任务标题、PR 编号或历史消息" : state.loading && state.query == normalized ? "正在搜索消息…" : "没有找到任务")
                                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(24)
                        }
                    }.padding(8)
                }.onChange(of: highlighted) { _, id in if let id { proxy.scrollTo(id, anchor: .center) } }
            }
            if state.query == normalized, let error = state.error {
                Divider()
                HStack(alignment: .top, spacing: 10) {
                    Text(fridayString: error).font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    if store.connected, normalized.utf16.count >= 2, normalized.utf16.count <= 200 {
                        Button { attempt += 1 } label: { FridaySymbolImage(systemName: "arrow.clockwise") }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "重新搜索"))
                    }
                }.padding(12)
            } else if !normalized.isEmpty, normalized.utf16.count < 2 {
                Divider(); Text(friday: "输入至少 2 个字符搜索消息").font(.caption).foregroundStyle(.secondary).padding(12)
            }
        }
        #if os(macOS)
        .frame(width: 420, height: 440)
        #else
        .frame(maxWidth: .infinity).frame(minHeight: 260, idealHeight: 440, maxHeight: 540).padding(.top, 8)
        #endif
        .onChange(of: results.map(\.id)) { _, ids in selected = ids.first }
        .task(id: requestKey) { await search(requestKey) }
        #if os(iOS)
        .task { focused = true }
        #endif
    }

    private func resultRow(_ result: TaskSearchPresentation.Result) -> some View {
        Button { openTask(result.id) } label: {
            HStack(alignment: .top, spacing: 9) {
                let project = TaskWorkspaces.project(for: result.task, in: store.projects)
                WorkspaceIcon(name: TaskWorkspaces.name(for: result.task, in: store.projects), icon: project?.icon, color: project?.color, size: 16).padding(.top, 2)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        Text(verbatim: result.task.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                        Spacer(minLength: 4)
                        if let pr = TaskSearchPresentation.displayedPullRequest(result.task, query: normalized) { Text("#\(pr.number)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                        Text(TaskRowPresentation.age(result.task, now: .now)).font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                    }
                    if let match = result.match {
                        HStack(alignment: .top, spacing: 5) {
                            Text(fridayString: match.source == .user ? "你：" : "Agent：").foregroundStyle(match.source == .user ? Color.blue : Color.green)
                            Text(excerpt(match.snippet)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                        }.font(.caption)
                    }
                }
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(TaskRowButtonStyle(selected: highlighted == result.id))
            .accessibilityAddTraits(highlighted == result.id ? .isSelected : [])
            .onHover { if $0 { selected = result.id } }
    }
    private func excerpt(_ text: String) -> AttributedString {
        var value = AttributedString()
        for part in TaskSearchText.parts(text, query: normalized) {
            var piece = AttributedString(part.text)
            if part.highlighted { piece.foregroundColor = .primary; piece.font = .caption.weight(.semibold) }
            value.append(piece)
        }
        return value
    }
    private func move(_ delta: Int) -> Bool {
        guard let id = TaskSearchPresentation.moved(delta, selected: highlighted, ids: results.map(\.id)) else { return false }
        selected = id; return true
    }
    private func choose() -> Bool {
        guard let highlighted else { return false }; openTask(highlighted); return true
    }
    private func escape() { if !query.isEmpty { query = "" } else { dismiss() } }
    @MainActor private func search(_ key: RequestKey) async {
        guard let request = state.begin(key.query, scope: key.scope, session: key.session) else { return }
        guard key.connected, store.snapshotIdentity == store.connectionIdentity else {
            state.fail("连接主机后可搜索历史消息", for: request, scope: scopeKey, session: store.taskStreamSession); return
        }
        do {
            try await Task.sleep(for: .milliseconds(200))
            let response = try await store.searchTasks(request.query)
            guard !Task.isCancelled else { return }
            if !state.accept(response, for: request, scope: scopeKey, session: store.taskStreamSession, tasks: tasks) {
                state.fail("搜索结果已改变，请重试", for: request, scope: scopeKey, session: store.taskStreamSession)
            }
        } catch {
            guard !Task.isCancelled else { return }
            state.fail(error.localizedDescription, for: request, scope: scopeKey, session: store.taskStreamSession)
        }
    }
}

#if os(macOS)
import AppKit
struct TaskSearchField: NSViewRepresentable {
    @Binding var text: String
    let move: (Int) -> Bool
    let submit: () -> Bool
    let escape: () -> Void
    var placeholder = "搜索任务标题、PR 或消息…"
    var accessibilityLabel = "搜索任务"
    var settings: (() -> Void)? = nil
    var autoFocus = true
    var focusRequest = 0
    @Environment(\.locale) private var locale
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> Field {
        let field = Field(); field.controlSize = .regular; field.sendsSearchStringImmediately = true; field.sendsWholeSearchString = false
        field.delegate = context.coordinator; field.target = context.coordinator; field.action = #selector(Coordinator.changed(_:))
        field.autoFocus = autoFocus; field.stringValue = text; return field
    }
    func updateNSView(_ field: Field, context: Context) {
        context.coordinator.owner = self
        field.placeholderString = String(localized: String.LocalizationValue(placeholder), bundle: .module, locale: locale)
        field.setAccessibilityLabel(String(localized: String.LocalizationValue(accessibilityLabel), bundle: .module, locale: locale))
        field.settings = settings
        if field.focusRequest != focusRequest {
            field.focusRequest = focusRequest
            DispatchQueue.main.async { [weak field] in guard let field, field.delegate != nil else { return }; field.window?.makeFirstResponder(field) }
        }
        if (field.currentEditor() as? NSTextView)?.hasMarkedText() != true, field.stringValue != text { field.stringValue = text }
    }
    static func dismantleNSView(_ field: Field, coordinator: Coordinator) { field.delegate = nil; field.target = nil }
    final class Field: NSSearchField {
        private var focused = false
        var autoFocus = true
        var focusRequest = 0
        var settings: (() -> Void)?
        override func keyDown(with event: NSEvent) {
            if event.keyCode == 109, event.modifierFlags.intersection([.shift, .control, .option, .command]) == .shift,
               (currentEditor() as? NSTextView)?.hasMarkedText() != true, let settings { settings(); return }
            super.keyDown(with: event)
        }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow(); guard autoFocus, window != nil, !focused else { return }; focused = true
            DispatchQueue.main.async { [weak self] in guard let self, self.delegate != nil else { return }; self.window?.makeFirstResponder(self) }
        }
    }
    final class Coordinator: NSObject, NSSearchFieldDelegate {
        var owner: TaskSearchField
        init(_ owner: TaskSearchField) { self.owner = owner }
        @objc func changed(_ sender: NSSearchField) { owner.text = sender.stringValue }
        func controlTextDidChange(_ notification: Notification) { if let field = notification.object as? NSSearchField { changed(field) } }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy command: Selector) -> Bool {
            guard !textView.hasMarkedText() else { return false }
            if command == #selector(NSResponder.moveDown(_:)) { return owner.move(1) }
            if command == #selector(NSResponder.moveUp(_:)) { return owner.move(-1) }
            if command == #selector(NSResponder.insertNewline(_:)) { return owner.submit() }
            if command == #selector(NSResponder.cancelOperation(_:)) { owner.escape(); return true }
            return false
        }
    }
}
#endif
