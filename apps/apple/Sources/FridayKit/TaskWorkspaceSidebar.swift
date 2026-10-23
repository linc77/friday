import SwiftUI
#if os(macOS)
import AppKit
#endif

struct TaskWorkspaceSidebar: View {
    @ObservedObject var store: FridayStore
    @Binding var scope: String?
    @Binding var draftProjectId: String?
    @Binding var selectedTask: String?
    let newTask: () -> Void
    @State private var showingWorkspaceAdd = false
    @State private var editingWorkspace: Project?
    @State private var showingHistory = false
    @State private var showingArchives = false
    @State private var showingSearch = false
    @State private var error: String?
    @State private var showingProjectPicker = false
    @State private var clock = Date()
    @State private var sidebarDragToken = UUID()
    @State private var sidebarMove: UUID?
    @StateObject private var bulk = TaskBulkActions()
    @AppStorage("friday.tasks.expandedShelves") private var expandedShelfData = Data()
    @AppStorage(FridayPreferenceKeys.legacySidebar) private var legacySidebar = false
    @AppStorage(FridayPreferenceKeys.projectGrouping) private var grouping: TaskProjectGrouping = .repository
    @AppStorage(FridayPreferenceKeys.projectSort) private var projectSort: TaskProjectSort = .updated
    @AppStorage(FridayPreferenceKeys.threadSort) private var threadSort: TaskThreadSort = .updated
    @AppStorage(FridayPreferenceKeys.threadPreviewCount) private var threadPreviewCount = 6
    @AppStorage(FridayPreferenceKeys.projectGroupingOverrides) private var groupingOverrides = Data()
    @AppStorage(FridayPreferenceKeys.projectOrder) private var projectOrder = Data()
    @AppStorage(FridayPreferenceKeys.projectScope) private var savedScopes = Data()
    @AppStorage("friday.tasks.collapsedProjectTrees") private var collapsedProjectTrees = Data()
    @State private var expandedProjectThreads: Set<String> = []
    @State private var projectGroupCache = TaskProjectSidebar.Cache()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.locale) private var locale
    #if os(macOS)
    @Environment(\.fridayModelJump) private var modelJump
    @Environment(\.fridayTitleEditors) private var titleEditors
    private var navigationActions: TaskNavigationActions {
        return TaskNavigationActions(rows: visibleRows,
            selected: selectedTask, model: modelJump.wrappedValue, editingTitle: !titleEditors.wrappedValue.isEmpty, open: selectTask, search: { showingSearch = true })
    }
    #endif

    private var groupVersion: TaskProjectSidebar.Version {
        TaskProjectSidebar.version(store.projects, tasks: store.tasks, mode: grouping,
            overrides: TaskProjectSidebar.dictionaries(groupingOverrides)[store.connection.server] ?? [:],
            order: projectSort, preferred: TaskProjectSidebar.orders(projectOrder)[store.connection.server] ?? [], context: store.connectionIdentity + "\n" + store.snapshotIdentity)
    }
    private var projectGroups: [TaskProjectSidebar.Group] {
        guard store.snapshotIdentity == store.connectionIdentity else { return [] }
        return projectGroupCache.resolve(groupVersion, projects: store.projects, tasks: store.tasks)
    }
    private var selectedGroup: TaskProjectSidebar.Group? { projectGroups.first { $0.id == scope } }
    private var scopedGroups: [TaskProjectSidebar.Group] { selectedGroup.map { [$0] } ?? projectGroups }
    private var collapsedProjects: Set<String> { Set(TaskProjectSidebar.orders(collapsedProjectTrees)[store.connection.server] ?? []) }
    private var visibleRows: [WorkItem] {
        if legacySidebar { return scopedGroups.flatMap { group in
            TaskProjectSidebar.preview(legacyTasks(group), expanded: !collapsedProjects.contains(group.id), overflow: expandedProjectThreads.contains(group.id), count: threadPreviewCount, selected: selectedTask)
        } }
        return TaskSidebarNavigation.visible(sidebarTasks, now: clock, expanded: expandedShelves, selected: selectedTask, workingShelfEnabled: store.sidebarWorkingShelfEnabled, returnedAt: store.sidebarInboxReturns.returnedAt)
    }
    private var historyTasks: [WorkItem] {
        store.tasks.filter {
            $0.localAgent && $0.subagentOrigin == nil && $0.archivedAt == nil && $0.projectId != nil && TaskWorkspaces.project(for: $0, in: store.projects) == nil
        }.sorted { $0.updatedAt > $1.updatedAt }
    }
    private var motion: Animation? { reduceMotion || scenePhase != .active ? nil : FridayTheme.motion }
    private var newTaskHint: String {
        #if os(macOS)
        "新任务；按住 Shift 在当前项目中新建"
        #else
        "新任务"
        #endif
    }
    private var expandedShelves: Set<String> {
        Set((try? JSONDecoder().decode([String].self, from: expandedShelfData)) ?? [])
    }
    private var sidebarContext: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy") + "\n" + (scope ?? "") + "\n" + String(store.sidebarWorkingShelfEnabled) }
    private var sidebarTasks: [WorkItem] {
        sidebarTasks(in: selectedGroup)
    }
    private func sidebarTasks(in group: TaskProjectSidebar.Group?) -> [WorkItem] {
        guard store.snapshotIdentity == store.connectionIdentity else { return [] }
        return TaskProjectSidebar.filtered(TaskWorkspaces.tasks(store.tasks, scope: nil, projects: store.projects).filter { $0.projectId == nil || TaskWorkspaces.project(for: $0, in: store.projects) != nil }, group: group, projects: store.projects)
    }
    private var canMove: Bool { !legacySidebar && store.connected && store.snapshotIdentity == store.connectionIdentity && store.taskSidebarOrderingSupported && (selectedGroup == nil || selectedGroup?.projectIDs.count == 1 || store.taskSidebarProjectScopesSupported) && (!store.sidebarWorkingShelfEnabled || store.taskSidebarWorkingSupported) && sidebarMove == nil && !bulk.selection.hasSelection && !bulk.busy }

    var body: some View {
        TaskSidebarSearchShell(store: store, projectIDs: selectedGroup?.projectIDs, includeUnassociated: selectedGroup?.scratch == true, focus: $showingSearch, select: selectTask) {
            header
        } content: {
        VStack(spacing: 0) {
            TaskBulkBar(store: store, actions: bulk)
            TaskUndoNotice(store: store, state: store.taskUndo).padding(.horizontal, 12)
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).padding(.horizontal, 16).padding(.bottom, 8) }
            if !pendingClones.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(pendingClones) { project in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(verbatim: project.name).font(.caption.weight(.medium))
                                ProjectCloneControl(store: store, project: project).id(project.id)
                            }
                        }
                    }.padding(.horizontal, 12).padding(.vertical, 6)
                }.frame(maxHeight: pendingClones.count > 1 ? 260 : 170)
            }
            workspacePages
            footer
        }
        }
        .background(FridayTheme.canvas)
        .taskBulkPresentation(store: store, actions: bulk, beforeExecute: parkForBulk)
        .sheet(isPresented: $showingWorkspaceAdd) {
            WorkspaceAddView(store: store) { project in draftProjectId = project.id; select(project.id); newTask() }.environment(\.locale, locale)
        }
        .sheet(isPresented: $showingArchives) {
            VStack(spacing: 0) {
                HStack { Spacer(); Button(friday: "关闭") { showingArchives = false }.buttonStyle(FridayButtonStyle()) }.padding(16)
                TaskArchivedTasks(store: store)
            }.frame(minWidth: 480, minHeight: 460)
        }
        #if os(macOS)
        .focusedSceneValue(\.fridayTaskNavigation, navigationActions)
        .onExitCommand { if titleEditors.wrappedValue.isEmpty, !bulk.busy { bulk.selection.clear() } }
        #endif
        .onChange(of: projectGroups.map(\.id)) { _, _ in reconcileWorkspaces() }
        .onChange(of: store.projects.map(\.id)) { _, _ in reconcileWorkspaces() }
        .onChange(of: scope) { _, _ in
            bulk.selection.clear(); showingProjectPicker = false; reconcileWorkspaces()
            var scopes = TaskProjectSidebar.scopes(savedScopes); scopes[store.connection.server] = scope
            if let encoded = try? JSONEncoder().encode(scopes) { savedScopes = encoded }
        }
        .onChange(of: store.connectionIdentity) { _, _ in scope = TaskProjectSidebar.scopes(savedScopes)[store.connection.server]; expandedProjectThreads = []; showingProjectPicker = false; editingWorkspace = nil }
        .onAppear { if scope == nil { scope = TaskProjectSidebar.scopes(savedScopes)[store.connection.server] }; reconcileWorkspaces() }
        .onChange(of: store.connected) { _, _ in reconcileWorkspaces() }
        .onChange(of: sidebarContext) { _, _ in sidebarDragToken = UUID(); sidebarMove = nil; error = nil }
        .onChange(of: store.tasks.map(\.id)) { _, ids in
            if let selectedTask, !ids.contains(selectedTask) { self.selectedTask = nil }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { showingProjectPicker = false; showingHistory = false }
        }
        .task {
            while !Task.isCancelled {
                clock = .now
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
    }

    private var pendingClones: [Project] {
        guard store.snapshotIdentity == store.connectionIdentity else { return [] }
        return store.projects.filter { project in
            project.clone?.blocksTasks == true && (selectedGroup == nil || selectedGroup!.projectIDs.contains(project.id))
        }
    }

    private var header: some View {
        HStack(spacing: 4) {
            Button { showingProjectPicker.toggle() } label: {
                if let group = selectedGroup, !group.scratch { WorkspaceIcon(name: group.name, icon: group.representative.icon, color: group.representative.color, size: 15).frame(width: 28, height: 28) }
                else { FridaySymbolImage(systemName: "line.3.horizontal.decrease").frame(width: 28, height: 28) }
            }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "按 Workspace 筛选任务"))
                .accessibilityLabel(Text(friday: "按 Workspace 筛选任务")).accessibilityValue(selectedGroup.map { $0.scratch ? Text(friday: "无项目") : Text(verbatim: $0.name) } ?? Text(friday: "全部 Workspace"))
                .popover(isPresented: $showingProjectPicker) {
                    TaskSidebarProjectPicker(groups: projectGroups, selected: scope, select: select, settings: openSettings, dismiss: { showingProjectPicker = false })
                        .environment(\.locale, locale)
                }
            #if os(macOS)
            if store.deviceId == "owner" {
                Button { showingWorkspaceAdd = true } label: { FridaySymbolImage(systemName: "folder.badge.plus").frame(width: 28, height: 28) }
                    .buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "添加 Workspace")).accessibilityLabel(Text(friday: "添加 Workspace")).disabled(!store.connected)
            }
            #endif
            Button(action: newTaskFromContext) {
                FridaySymbolImage(systemName: "square.and.pencil").frame(width: 28, height: 28)
            }.buttonStyle(FridaySymbolButtonStyle()).help(Text(fridayString: newTaskHint)).accessibilityLabel(Text(friday: "新任务")).disabled(store.projects.isEmpty && store.scratchWorkspaceRoot == nil)
        }
            .popover(item: $editingWorkspace, arrowEdge: .bottom) { WorkspaceIdentityEditor(store: store, project: $0).environment(\.locale, locale) }
    }
    private func openSettings(_ project: Project) {
        showingProjectPicker = false
        let identity = store.connectionIdentity
        Task { @MainActor in
            await Task.yield()
            guard identity == store.connectionIdentity, store.snapshotIdentity == identity else { return }
            editingWorkspace = store.projects.first { $0.id == project.id }
        }
    }
    private func newTaskFromContext() {
        #if os(macOS)
        let currentProject = NSEvent.modifierFlags.contains(.shift)
        #else
        let currentProject = false
        #endif
        if !currentProject && projectGroups.count > 1 { draftProjectId = nil }
        else {
            let previous = selectedTask.flatMap { id in store.tasks.first { $0.id == id }?.projectId } ?? draftProjectId
            let preferred = previous.flatMap { id in store.projects.first { $0.id == id } }
            draftProjectId = preferred?.id ?? selectedGroup?.draftProjectID ?? projectGroups.first?.draftProjectID
        }
        newTask()
    }

    private func legacyTasks(_ group: TaskProjectSidebar.Group) -> [WorkItem] {
        TaskProjectSidebar.threads(sidebarTasks(in: group), order: threadSort)
    }
    @ViewBuilder private var workspacePages: some View {
        #if os(macOS)
        TaskWorkspacePages(pages: [nil] + projectGroups.map { Optional($0.id) }, selection: scope,
            context: store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy"), select: select) { id in
            workspacePage(id)
        }
        #else
        workspacePage(scope)
        #endif
    }
    @ViewBuilder private func workspacePage(_ id: String?) -> some View {
        let group = id.flatMap { key in projectGroups.first { $0.id == key } }
        if legacySidebar { legacyProjectList(groups: group.map { [$0] } ?? projectGroups) }
        else { taskList(tasks: sidebarTasks(in: group)) }
    }
    private func legacyProjectList(groups: [TaskProjectSidebar.Group]) -> some View {
        ScrollView {
            LazyVStack(spacing: 3) {
                ForEach(groups) { group in
                    let rows = legacyTasks(group), expanded = !collapsedProjects.contains(group.id)
                    HStack(spacing: 3) {
                        Button { toggleProject(group.id) } label: {
                            HStack(spacing: 7) {
                                FridaySymbolImage(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 9))
                                WorkspaceIcon(name: group.name, icon: group.representative.icon, color: group.representative.color, size: 13)
                                Group { if group.scratch { Text(friday: "无项目") } else { Text(verbatim: group.name) } }.lineLimit(1)
                                Spacer(minLength: 0)
                                Text("\(rows.count)").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, minHeight: 28).contentShape(Rectangle())
                        }.buttonStyle(FridaySymbolButtonStyle()).accessibilityValue(Text(friday: expanded ? "已展开" : "已收起"))
                        if !group.scratch {
                            Button { draftProjectId = group.draftProjectID; newTask() } label: { FridaySymbolImage(systemName: "plus").frame(width: 23, height: 26) }
                                .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "新任务") + Text("：\(group.name)"))
                        }
                        Menu {
                            if !group.scratch { Button(friday: "Workspace 设置") { openSettings(group.representative) } }
                            if projectSort == .manual, scope == nil {
                                Button(friday: "向上移动") { moveProject(group.id, delta: -1) }.disabled(projectGroups.first?.id == group.id)
                                Button(friday: "向下移动") { moveProject(group.id, delta: 1) }.disabled(projectGroups.last?.id == group.id)
                            }
                        } label: { FridaySymbolImage(systemName: "ellipsis").frame(width: 23, height: 26) }.menuStyle(.borderlessButton).fixedSize().fridayInteractiveCursor().accessibilityLabel(Text(friday: "Workspace 操作"))
                    }.font(.system(size: 12, weight: .medium)).padding(.horizontal, 8).padding(.top, 6)
                        .modifier(TaskProjectTreeDrag(enabled: projectSort == .manual && scope == nil, id: group.id) { source in reorderProject(source, over: group.id) })
                        .contextMenu { if !group.scratch { Button(friday: "Workspace 设置") { openSettings(group.representative) } } }
                    ForEach(TaskProjectSidebar.preview(rows, expanded: expanded, overflow: expandedProjectThreads.contains(group.id), count: threadPreviewCount, selected: selectedTask)) { task in taskButton(task).padding(.leading, 10) }
                    if expanded && rows.count > max(1,min(15,threadPreviewCount)) {
                        Button(friday: expandedProjectThreads.contains(group.id) ? "收起任务列表" : "显示更多任务") {
                            if !expandedProjectThreads.insert(group.id).inserted { expandedProjectThreads.remove(group.id) }
                        }.buttonStyle(FridayButtonStyle(compact: true)).font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 24)
                    }
                }
            }.padding(.horizontal, TaskSidebarLayout.listInset).padding(.bottom, 12)
        }
    }
    private func toggleProject(_ id: String) {
        var collapsed = collapsedProjects
        if !collapsed.insert(id).inserted { collapsed.remove(id) }
        var saved = TaskProjectSidebar.orders(collapsedProjectTrees); saved[store.connection.server] = collapsed.sorted()
        if let data = try? JSONEncoder().encode(saved) { collapsedProjectTrees = data }
    }
    private func moveProject(_ id: String, delta: Int) {
        guard let current = projectGroups.firstIndex(where: { $0.id == id }), projectGroups.indices.contains(current + delta) else { return }
        _ = reorderProject(id, over: projectGroups[current + delta].id)
    }
    private func reorderProject(_ source: String, over destination: String) -> Bool {
        guard projectSort == .manual, source != destination,
              let from = projectGroups.firstIndex(where: { $0.id == source }), let to = projectGroups.firstIndex(where: { $0.id == destination }) else { return false }
        var groups = projectGroups; groups.insert(groups.remove(at: from), at: to)
        var saved = TaskProjectSidebar.orders(projectOrder)
        saved[store.connection.server] = groups.flatMap(\.members).map { TaskProjectSidebar.normalize($0.path) }
        if let data = try? JSONEncoder().encode(saved) { projectOrder = data; return true }; return false
    }

    private func taskList(tasks: [WorkItem]) -> some View {
        return ScrollView {
            LazyVStack(spacing: 3) {
                if tasks.isEmpty {
                    VStack(spacing: 9) {
                        Text(friday: "这个 Workspace 还没有任务")
                            .font(.callout.weight(.medium))
                        Text(friday: "点击上方新任务按钮开始。")
                            .font(.caption).foregroundStyle(.secondary)
                    }.multilineTextAlignment(.center).padding(.horizontal, 20).padding(.top, 44)
                }
                ForEach(TaskWorkspaces.Shelf.allCases) { shelf in
                    let rows = TaskWorkspaces.shelfTasks(tasks, shelf: shelf, now: clock, workingShelfEnabled: store.sidebarWorkingShelfEnabled, returnedAt: store.sidebarInboxReturns.returnedAt)
                    if shelf != .snoozed && shelf != .working {
                        Color.clear.frame(height: 8).contentShape(Rectangle())
                            .modifier(TaskSidebarDropTarget(enabled: canMove) { payload, _ in moveInSidebar(payload, section: shelf, over: nil, after: false) })
                    }
                    if !rows.isEmpty {
                        if shelf == .snoozed || shelf == .settled || shelf == .working {
                            shelfHeader(shelf, count: rows.count)
                                .modifier(TaskSidebarDropTarget(enabled: canMove && shelf == .settled) { payload, _ in moveInSidebar(payload, section: shelf, over: nil, after: false) })
                            ForEach(expandedShelves.contains(shelf.id) ? rows : rows.filter { $0.id == selectedTask }) { task in sidebarRow(task, shelf: shelf) }
                        } else {
                            ForEach(rows) { task in sidebarRow(task, shelf: shelf) }
                            if shelf == .pinned { Divider().padding(.horizontal, TaskSidebarLayout.rowInset).padding(.vertical, 6) }
                        }
                    }
                }
            }.padding(.horizontal, TaskSidebarLayout.listInset).padding(.bottom, 12)
        }
    }

    private func sidebarRow(_ task: WorkItem, shelf: TaskWorkspaces.Shelf) -> some View {
        taskButton(task)
            .modifier(TaskSidebarDropTarget(enabled: canMove && shelf != .snoozed && shelf != .working) { payload, after in moveInSidebar(payload, section: shelf, over: task.id, after: after) })
    }

    private func shelfHeader(_ shelf: TaskWorkspaces.Shelf, count: Int) -> some View {
        let expanded = expandedShelves.contains(shelf.id)
        return Button { toggleShelf(shelf.id) } label: {
            HStack(spacing: TaskSidebarLayout.iconSpacing) {
                FridaySymbolImage(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .medium)).frame(width: TaskSidebarLayout.iconSize)
                Text(fridayString: shelf.title).lineLimit(1)
                Text("\(count)").monospacedDigit()
                Spacer(minLength: 0)
            }
            .font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
            .frame(minHeight: 24).padding(.horizontal, TaskSidebarLayout.rowInset).contentShape(Rectangle())
        }
        .buttonStyle(WorkspaceTitleButtonStyle())
        .padding(.top, 8).padding(.bottom, 2)
        .accessibilityLabel(Text(fridayString: shelf.title))
        .accessibilityValue(Text(fridayString: expanded ? "已展开" : "已收起"))
        .accessibilityHint(Text(fridayString: expanded ? "收起任务" : "展开任务"))
        .accessibilityAddTraits(.isHeader)
        .help(Text(fridayString: expanded ? "收起任务" : "展开任务"))
    }

    private func toggleShelf(_ id: String) {
        var expanded = expandedShelves
        if !expanded.insert(id).inserted { expanded.remove(id) }
        guard let data = try? JSONEncoder().encode(expanded.sorted()) else { return }
        withAnimation(motion) { expandedShelfData = data }
    }

    private func taskButton(_ task: WorkItem, closesHistory: Bool = false) -> some View {
        let payload = canMove && !closesHistory && TaskWorkspaces.shelf(task, now: clock, workingShelfEnabled: store.sidebarWorkingShelfEnabled) != .working ? TaskSidebarDragPayload(token: sidebarDragToken, taskID: task.id, section: TaskWorkspaces.shelf(task, now: clock, workingShelfEnabled: store.sidebarWorkingShelfEnabled).rawValue) : nil
        let movement = !closesHistory ? sidebarMovement(task) : nil
        #if os(macOS)
        return TaskSidebarTaskButton(store: store, task: task,
            selected: bulk.selection.hasSelection ? bulk.selection.selected.contains(task.id) : selectedTask == task.id,
            showsWorkspace: !legacySidebar && (selectedGroup == nil || (selectedGroup?.members.count ?? 0) > 1), select: {
                if !closesHistory, NSEvent.modifierFlags.contains(.command) {
                    guard !bulk.busy else { return }; bulk.selection.toggle(task.id)
                } else if !closesHistory, NSEvent.modifierFlags.contains(.shift) {
                    guard !bulk.busy else { return }
                    let ordered = visibleRows.map(\.id)
                    bulk.selection.range(to: task.id, ordered: ordered)
                } else { selectTask(task.id) }
            }, removed: { if selectedTask == task.id { selectedTask = nil } }, dragPayload: payload, sidebarMovement: movement,
            bulk: closesHistory ? nil : bulk.menu(store, row: task.id))
        #else
        return Button {
            selectedTask = task.id; if closesHistory { showingHistory = false }
            Task { await store.markTaskRead(task) }
        } label: {
            TaskRow(task: task, workspaceName: TaskWorkspaces.name(for: task, in: store.projects), workspace: TaskWorkspaces.project(for: task, in: store.projects), selected: selectedTask == task.id, showsWorkspace: !legacySidebar && (selectedGroup == nil || (selectedGroup?.members.count ?? 0) > 1),
                acknowledgeWake: { Task { await store.acknowledgeTaskWake(task) } })
                .padding(.horizontal, TaskSidebarLayout.rowInset).foregroundStyle(.primary)
        }.buttonStyle(TaskRowButtonStyle(selected: selectedTask == task.id))
            .accessibilityAddTraits(selectedTask == task.id ? .isSelected : [])
            .help("\(task.title)\n\(task.cwd)")
            .taskActions(store: store, task: task, sidebarMovement: movement, onRemoved: { if selectedTask == task.id { selectedTask = nil } })
            .modifier(TaskSidebarDragSource(payload: payload))
        #endif
    }

    private func sidebarMovement(_ task: WorkItem) -> TaskSidebarMovement? {
        let shelf = TaskWorkspaces.shelf(task, now: clock, workingShelfEnabled: store.sidebarWorkingShelfEnabled)
        guard canMove, shelf == .pinned || shelf == .active && !store.sidebarWorkingShelfEnabled else { return nil }
        let rows = TaskWorkspaces.shelfTasks(sidebarTasks, shelf: shelf, now: clock, workingShelfEnabled: store.sidebarWorkingShelfEnabled, returnedAt: store.sidebarInboxReturns.returnedAt)
        guard let index = rows.firstIndex(where: { $0.id == task.id }) else { return nil }
        let payload = TaskSidebarDragPayload(token: sidebarDragToken, taskID: task.id, section: shelf.rawValue)
        return TaskSidebarMovement(up: index > 0 ? { moveInSidebar(payload, section: shelf, over: rows[index - 1].id, after: false) } : nil,
            down: index + 1 < rows.count ? { moveInSidebar(payload, section: shelf, over: rows[index + 1].id, after: true) } : nil)
    }

    private func moveInSidebar(_ payload: TaskSidebarDragPayload, section: TaskWorkspaces.Shelf, over: String?, after: Bool) {
        guard canMove, let move = TaskSidebarOrdering.plan(payload, token: sidebarDragToken, tasks: sidebarTasks, projectID: !store.taskSidebarProjectScopesSupported && selectedGroup?.projectIDs.count == 1 ? selectedGroup?.projectIDs.first : nil, section: section, over: over, after: after, now: .now, workingShelfEnabled: store.sidebarWorkingShelfEnabled, returnedAt: store.sidebarInboxReturns.returnedAt, projectIDs: store.taskSidebarProjectScopesSupported ? selectedGroup?.projectIDs : nil, includeUnassociated: store.taskScratchWorkspaceSupported && selectedGroup?.scratch == true) else { return }
        let context = sidebarContext; let connection = store.connection; let operation = UUID(); sidebarMove = operation; error = nil
        Task { @MainActor in
            defer { if sidebarMove == operation { sidebarMove = nil } }
            guard sidebarContext == context, sidebarMove == operation else { return }
            do {
                if section == .pinned { store.taskUndo.invalidatePin(taskID: move.taskID) }
                let source = move.body["source"] as? String, path = "/api/tasks/\(move.taskID)/sidebar/move"
                var lifecycle: [String: Any]?
                if section == .settled, source != "settled" { lifecycle = ["settled": true] }
                else if source == "settled" { lifecycle = ["settled": false] }
                else if source == "pinned", section == .active { lifecycle = ["pinned": false] }
                else if source == "snoozed" { lifecycle = ["snoozedUntil": NSNull()] }
                if let lifecycle { try await store.taskUndo.perform(store: store, taskID: move.taskID, changes: lifecycle, path: path, method: "POST", payload: move.body) }
                else { _ = try await connection.data(path, method: "POST", body: move.body) }
                guard sidebarContext == context, sidebarMove == operation else { return }
                if section == .settled, !expandedShelves.contains(section.id) { toggleShelf(section.id) }
                await store.refresh()
            } catch {
                guard sidebarContext == context, sidebarMove == operation else { return }
                self.error = error.localizedDescription
                await store.refresh()
            }
        }
    }

    private func selectTask(_ id: String) {
        guard store.snapshotIdentity == store.connectionIdentity, let task = store.tasks.first(where: { $0.id == id && $0.localAgent }) else { return }
        selectedTask = id; showingHistory = false
        bulk.selection.activate(id)
        Task { await store.markTaskRead(task) }
    }

    private func parkForBulk(_ plan: TaskBulkPlan) {
        guard [.settle, .snooze, .delete].contains(plan.action), let current = selectedTask, plan.taskIDs.contains(current) else { return }
        let rows = visibleRows
        guard let index = rows.firstIndex(where: { $0.id == current }) else { selectedTask = nil; return }
        let following = Array(rows.dropFirst(index + 1)) + rows.prefix(index)
        let next = following.first { task in
            let shelf = TaskWorkspaces.shelf(task, now: clock, workingShelfEnabled: store.sidebarWorkingShelfEnabled)
            return !plan.taskIDs.contains(task.id) && shelf != .settled && shelf != .snoozed
        }
        selectedTask = next?.id
        if let next { Task { await store.markTaskRead(next) } }
    }

    private var footer: some View {
        HStack {
            Button { showingHistory.toggle() } label: { FridaySymbolImage(systemName: "archivebox").frame(width: 32, height: 32) }
                .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "历史任务")).help(Text(friday: "历史任务"))
                .popover(isPresented: $showingHistory, arrowEdge: .bottom) { historyPanel.environment(\.locale, locale) }
            Spacer(minLength: 0)
            if let group = selectedGroup { Group { if group.scratch { Text(friday: "无项目") } else { Text(verbatim: group.name) } }.font(.caption).foregroundStyle(.secondary).lineLimit(1) }
        }.padding(.horizontal, 10).padding(.bottom, 8)
    }

    private var historyPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(friday: "历史任务").font(.headline)
                Spacer()
                Text("\(historyTasks.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Button(friday: "已归档任务", systemImage: "archivebox") { showingHistory = false; showingArchives = true }
                .buttonStyle(FridayButtonStyle(compact: true))
            if historyTasks.isEmpty {
                Text(friday: "还没有历史任务")
                    .font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 64)
            } else {
                ScrollView {
                    LazyVStack(spacing: 3) {
                        ForEach(historyTasks) { task in taskButton(task, closesHistory: true) }
                    }
                }.scrollBounceBehavior(.basedOnSize)
                    .frame(height: min(320, max(80, CGFloat(historyTasks.count) * 48)))
            }
        }.padding(16).frame(width: 320)
    }

    private func select(_ id: String?) {
        let group = id.flatMap { key in projectGroups.first { $0.id == key || $0.projectIDs.contains(key) } }
        scope = group?.id
        showingProjectPicker = false; bulk.selection.clear()
    }

    private func reconcileWorkspaces() {
        // A disconnected/initial cache cannot establish that a Workspace is gone.
        guard store.connected, store.snapshotIdentity == store.connectionIdentity else { return }
        let ids = store.projects.map(\.id)
        if let scope, !projectGroups.contains(where: { $0.id == scope }) {
            if projectGroups.contains(where: { $0.projectIDs.contains(scope) }) { select(scope) } else { select(nil) }
        }
        if let draftProjectId, !ids.contains(draftProjectId) { self.draftProjectId = selectedGroup?.draftProjectID }
    }

}

private struct TaskProjectTreeDrag: ViewModifier {
    let enabled: Bool
    let id: String
    let move: (String) -> Bool
    @ViewBuilder func body(content: Content) -> some View {
        if enabled {
            content.draggable("friday-project:" + id).dropDestination(for: String.self) { values, _ in
                guard values.count == 1, let value = values.first, value.hasPrefix("friday-project:") else { return false }
                return move(String(value.dropFirst("friday-project:".count)))
            }
        } else { content }
    }
}
