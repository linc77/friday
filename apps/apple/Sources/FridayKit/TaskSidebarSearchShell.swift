import SwiftUI

struct TaskSidebarSearchShell<Toolbar: View, Content: View>: View {
    @ObservedObject var store: FridayStore
    let projectIDs: Set<String>?
    var includeUnassociated = false
    @Binding var focus: Bool
    let select: (String) -> Void
    @ViewBuilder let toolbar: () -> Toolbar
    @ViewBuilder let content: () -> Content
    @State private var query = ""
    @State private var search = TaskSearchState()
    @State private var highlighted: String?
    @State private var focusRequest = 0
    @State private var attempt = 0
    #if os(iOS)
    @FocusState private var focused: Bool
    #endif
    private struct Key: Equatable { let query: String; let scope: String; let session: String?; let connected: Bool; let attempt: Int }
    private var normalized: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var scope: String { store.connectionIdentity + "\n" + (projectIDs?.sorted().joined(separator: "\n") ?? "*") + "\n" + String(includeUnassociated) }
    private var key: Key { Key(query: normalized, scope: scope, session: store.taskStreamSession, connected: store.connected && store.snapshotIdentity == store.connectionIdentity, attempt: attempt) }
    private var tasks: [WorkItem] {
        guard store.snapshotIdentity == store.connectionIdentity else { return [] }
        guard let projectIDs else { return store.tasks }
        return store.tasks.filter { task in TaskWorkspaces.project(for: task, in: store.projects).map { projectIDs.contains($0.id) } ?? ((includeUnassociated || projectIDs.isEmpty) && task.projectId == nil) }
    }
    private var results: [TaskSearchPresentation.Result] { TaskSearchPresentation.results(tasks: tasks, projects: store.projects, scope: nil, query: query, matches: search.currentMatches(query, scope: scope, session: store.taskStreamSession), now: .now) }
    private var active: String? { highlighted.flatMap { id in results.contains { $0.id == id } ? id : nil } ?? results.first?.id }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                #if os(macOS)
                TaskSearchField(text: $query, move: move, submit: choose, escape: { query = "" }, placeholder: "搜索", autoFocus: false, focusRequest: focusRequest)
                    .frame(minWidth: 45, maxWidth: .infinity).frame(height: 28)
                #else
                TextField(friday: "搜索", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused).onSubmit { _ = choose() }.frame(maxWidth: .infinity)
                #endif
                toolbar()
            }.padding(.horizontal, 10).padding(.vertical, 8)
            if normalized.isEmpty { content() }
            else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 3) {
                            ForEach(results) { result in
                                Button { select(result.id) } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(marked(result.task.title)).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                        HStack(spacing: 5) {
                                            Group {
                                                if TaskWorkspaces.project(for: result.task, in: store.projects)?.isScratch == true { Text(friday: "无项目") }
                                                else { Text(verbatim: TaskWorkspaces.name(for: result.task, in: store.projects)) }
                                            }.lineLimit(1)
                                            if let pr = TaskSearchPresentation.displayedPullRequest(result.task, query: normalized) { Text("#\(pr.number)").monospacedDigit() }
                                            Spacer(minLength: 0)
                                        }.font(.caption2).foregroundStyle(.secondary)
                                        if let match = result.match { Text(marked(match.snippet)).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
                                    }.padding(.horizontal, 10).padding(.vertical, 7).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                }.buttonStyle(TaskRowButtonStyle(selected: active == result.id)).id(result.id)
                                    .accessibilityAddTraits(active == result.id ? .isSelected : []).onHover { if $0 { highlighted = result.id } }
                            }
                            if results.isEmpty { Text(friday: search.loading ? "正在搜索消息…" : "没有找到任务").font(.caption).foregroundStyle(.secondary).padding(20) }
                        }.padding(.horizontal, 8)
                    }.onChange(of: active) { _, id in if let id { proxy.scrollTo(id) } }
                }
                if let error = search.error, search.query == normalized {
                    HStack { Text(fridayString: error).font(.caption).foregroundStyle(.secondary); Spacer(minLength: 0); Button { attempt += 1 } label: { FridaySymbolImage(systemName: "arrow.clockwise") }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "重新搜索")) }.padding(10)
                }
            }
        }.onChange(of: results.map(\.id)) { _, _ in highlighted = results.first?.id }
            .onChange(of: focus) { _, value in if value { focusRequest += 1; focus = false
                #if os(iOS)
                focused = true
                #endif
            } }
            .onChange(of: store.connectionIdentity) { _, _ in query = ""; highlighted = nil }
            .task(id: key) { await load(key) }
    }
    private func marked(_ text: String) -> AttributedString {
        var value = AttributedString()
        for part in TaskSearchText.parts(text, query: normalized) { var piece = AttributedString(part.text); if part.highlighted { piece.foregroundColor = .primary; piece.font = .caption.weight(.semibold) }; value.append(piece) }; return value
    }
    private func move(_ delta: Int) -> Bool { guard let id = TaskSearchPresentation.moved(delta, selected: active, ids: results.map(\.id)) else { return false }; highlighted = id; return true }
    private func choose() -> Bool { guard let id = active else { return false }; select(id); return true }
    @MainActor private func load(_ key: Key) async {
        guard let request = search.begin(key.query, scope: key.scope, session: key.session) else { return }
        guard key.connected else { search.fail("连接主机后可搜索历史消息", for: request, scope: scope, session: store.taskStreamSession); return }
        do {
            try await Task.sleep(for: .milliseconds(200)); let response = try await store.searchTasks(request.query)
            guard !Task.isCancelled else { return }
            if !search.accept(response, for: request, scope: scope, session: store.taskStreamSession, tasks: tasks) { search.fail("搜索结果已改变，请重试", for: request, scope: scope, session: store.taskStreamSession) }
        } catch is CancellationError {} catch { search.fail(error.localizedDescription, for: request, scope: scope, session: store.taskStreamSession) }
    }
}
