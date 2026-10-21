import SwiftUI

struct TaskArchivedTasks: View {
    @ObservedObject var store: FridayStore
    @State private var scope: String?
    @State private var busy: Set<String> = []
    @State private var deletion: WorkItem?
    @State private var error: String?
    @State private var operation = UUID()
    private var identity: String { TaskActionUndo.context(store) }
    private var groups: [TaskArchiveIndex.Group] {
        store.snapshotIdentity == store.connectionIdentity ? TaskArchiveIndex.groups(tasks: store.tasks, projects: store.projects, scope: scope) : []
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text(friday: "已归档任务").font(.title2.bold())
                    Spacer()
                    Button { Task { await store.refresh() } } label: { FridaySymbolImage(systemName: "arrow.clockwise").frame(width: 28, height: 28) }
                        .buttonStyle(FridaySymbolButtonStyle()).disabled(!store.connected).accessibilityLabel(Text(friday: "刷新"))
                }
                Picker(selection: $scope) {
                    Text(friday: "全部 Workspace").tag(Optional<String>.none)
                    ForEach(store.projects) { project in Text(verbatim: project.name).tag(Optional(project.id)) }
                } label: { Text(friday: "Workspace") }.fridayInteractiveCursor()
                TaskUndoNotice(store: store, state: store.taskUndo)
                if let error { Text(error).font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
                if groups.isEmpty {
                    VStack(alignment: .leading, spacing: 7) {
                        FridaySymbolLabel(friday: store.connected ? "没有已归档任务" : "连接主机后查看已归档任务", systemImage: "archivebox")
                        Text(friday: "归档后的任务会显示在这里，可恢复或删除。")
                            .font(.callout).foregroundStyle(.secondary)
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading).fridayCard()
                }
                ForEach(groups) { group in
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { FridaySymbolImage(systemName: "folder"); Text(verbatim: group.title).font(.headline) }
                        ForEach(group.tasks) { task in
                            HStack(alignment: .top, spacing: 12) {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(verbatim: task.title).font(.callout).textSelection(.enabled)
                                    HStack(spacing: 4) {
                                        Text(friday: "已归档")
                                        if let date = CodexTranscript.date(task.archivedAt ?? task.createdAt) { Text(date, style: .relative) }
                                        Text("·"); Text(friday: "创建于")
                                        if let date = CodexTranscript.date(task.createdAt) { Text(date, style: .date) }
                                    }.font(.caption).foregroundStyle(.secondary)
                                    if task.archiveCleanup?.status == "pending" { Text(friday: "正在清理归档会话").font(.caption).foregroundStyle(.secondary) }
                                    if let message = task.archiveCleanup?.error { Text(fridayString: message).font(.caption).foregroundStyle(.orange) }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                Button(friday: "恢复任务", systemImage: "archivebox") { restore(task) }
                                    .buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected || busy.contains(task.id))
                            }.padding(12).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 9))
                                .contextMenu {
                                    Button(friday: "恢复任务", systemImage: "archivebox") { restore(task) }
                                    if task.archiveCleanup?.status == "interrupted" { Button(friday: "重新清理归档会话", systemImage: "arrow.clockwise") { retryCleanup(task) } }
                                    Button(friday: "删除任务", systemImage: "trash", role: .destructive) { deletion = task }
                                }.disabled(!store.connected || busy.contains(task.id))
                        }
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading).fridayCard()
                }
            }.padding(28).frame(maxWidth: 960).frame(maxWidth: .infinity)
        }.background(FridayTheme.canvas)
            .confirmationDialog(Text(friday: "删除任务？"), isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } }), titleVisibility: .visible) {
                if let task = deletion {
                    Button(friday: "删除任务", role: .destructive) { deletion = nil; remove(task) }
                }
                Button(friday: "取消", role: .cancel) { deletion = nil }
            } message: { Text(verbatim: deletion?.title ?? "") }
            .onChange(of: identity) { _, _ in operation = UUID(); busy = []; deletion = nil; error = nil; scope = nil }
            .onChange(of: store.projects.map(\.id)) { _, ids in if let scope, !ids.contains(scope) { self.scope = nil } }
    }
    private func restore(_ task: WorkItem) { perform(task) { try await store.taskUndo.perform(store: store, taskID: task.id, changes: ["archived": false]) } }
    private func retryCleanup(_ task: WorkItem) { perform(task) { _ = try await store.connection.data("/api/tasks/\(task.id)", method: "PATCH", body: ["archived": true, "requestId": UUID().uuidString]) } }
    private func remove(_ task: WorkItem) { perform(task) { _ = try await store.connection.data("/api/tasks/\(task.id)", method: "DELETE") } }
    private func perform(_ task: WorkItem, action: @escaping @MainActor () async throws -> Void) {
        guard store.connected, !busy.contains(task.id) else { return }
        let identity = identity, token = operation; busy.insert(task.id); error = nil
        Task { @MainActor in
            defer { if operation == token { busy.remove(task.id) } }
            guard self.identity == identity, operation == token else { return }
            do { try await action(); if self.identity == identity, operation == token { await store.refresh() } }
            catch { if self.identity == identity, operation == token { self.error = error.localizedDescription } }
        }
    }
}
