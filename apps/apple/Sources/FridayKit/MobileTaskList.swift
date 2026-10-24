#if os(iOS)
import SwiftUI

struct MobileTaskList: View {
    @ObservedObject var store: FridayStore
    @StateObject private var bulk = TaskBulkActions()
    @State private var selecting = false
    private var tasks: [WorkItem] {
        store.snapshotIdentity == store.connectionIdentity
            ? store.tasks.filter { $0.localAgent && $0.subagentOrigin == nil && $0.delegationOrigin == nil && $0.archivedAt == nil }.reversed() : []
    }
    var body: some View {
        List {
            TaskUndoNotice(store: store, state: store.taskUndo).listRowSeparator(.hidden)
            if bulk.selection.hasSelection || bulk.busy || !bulk.requests.outcome.failures.isEmpty {
                TaskBulkBar(store: store, actions: bulk).listRowSeparator(.hidden)
            }
            ForEach(tasks) { task in
                Group {
                    if selecting {
                        Button {
                            if !bulk.busy { bulk.selection.toggle(task.id) }
                        } label: {
                            HStack {
                                FridaySymbolImage(systemName: bulk.selection.selected.contains(task.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(bulk.selection.selected.contains(task.id) ? Color.accentColor : .secondary)
                                row(task)
                            }.foregroundStyle(.primary)
                        }.accessibilityAddTraits(bulk.selection.selected.contains(task.id) ? .isSelected : [])
                    } else {
                        NavigationLink(value: task.id) { row(task) }
                    }
                }.taskActions(store: store, task: task, bulk: bulk.menu(store, row: task.id))
            }
        }
        .refreshable { await store.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(friday: selecting ? "完成" : "选择") {
                    selecting.toggle()
                    if !selecting { bulk.selection.clear() }
                }.disabled(bulk.busy)
            }
        }
        .taskBulkPresentation(store: store, actions: bulk)
    }
    private func row(_ task: WorkItem) -> some View {
        TaskRow(task: task, workspaceName: TaskWorkspaces.name(for: task, in: store.projects), workspace: TaskWorkspaces.project(for: task, in: store.projects),
            selected: bulk.selection.selected.contains(task.id),
            acknowledgeWake: { Task { await store.acknowledgeTaskWake(task) } })
    }
}
#endif
