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
    @State private var adding = false
    @State private var editingWorkspace: Project?
    @State private var error: String?
    @State private var drag: CGFloat = 0
    @AppStorage("friday.tasks.collapsedWorkspaceGroups") private var collapsedWorkspaceData = Data()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.locale) private var locale

    private var pages: [String?] { [nil] + store.projects.map { Optional($0.id) } }
    private var index: Int { pages.firstIndex(of: scope) ?? 0 }
    private var project: Project? { store.projects.first { $0.id == scope } }
    private var motion: Animation? { reduceMotion || scenePhase != .active ? nil : FridayTheme.motion }
    private var collapsedWorkspaceGroups: Set<String> {
        Set((try? JSONDecoder().decode([String].self, from: collapsedWorkspaceData)) ?? [])
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let error { Text(error).font(.caption).foregroundStyle(.orange).padding(.horizontal, 16).padding(.bottom, 8) }
            GeometryReader { geometry in
                ZStack {
                    ForEach(pages.indices.filter { abs($0 - index) <= 1 }, id: \.self) { page in
                        taskList(scope: pages[page])
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .offset(x: CGFloat(page - index) * geometry.size.width + (reduceMotion ? 0 : drag))
                            .allowsHitTesting(page == index && drag == 0)
                            .accessibilityHidden(page != index)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
                #if os(macOS)
                .background(WorkspaceScrollGesture { delta in
                    let edge = (index == 0 && delta > 0) || (index == pages.count - 1 && delta < 0)
                    drag = max(-geometry.size.width * 0.85, min(geometry.size.width * 0.85, delta * (edge ? 0.22 : 1)))
                } ended: { swipe, cancelled in
                    let destination = swipe.destination(index: index, count: pages.count, cancelled: cancelled)
                    select(pages[destination])
                })
                #endif
            }
            footer
        }
        .background(FridayTheme.canvas)
        .onChange(of: store.projects.map(\.id)) { _, _ in reconcileWorkspaces() }
        .onChange(of: store.connected) { _, _ in reconcileWorkspaces() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { drag = 0 }
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            HStack(spacing: TaskSidebarLayout.iconSpacing) {
                if let project {
                    Button { editingWorkspace = project } label: {
                        HStack(spacing: TaskSidebarLayout.iconSpacing) {
                            WorkspaceIcon(name: project.name, icon: project.icon, color: project.color, size: TaskSidebarLayout.iconSize)
                            Text(project.name).lineLimit(1)
                        }.frame(maxWidth: .infinity, alignment: .leading).frame(height: 28).contentShape(Rectangle())
                    }.buttonStyle(WorkspaceTitleButtonStyle())
                        .accessibilityLabel(Text(friday: "编辑 Workspace") + Text("：\(project.name)"))
                        .help(Text(friday: "修改名称、图标和颜色"))
                        .disabled(!store.connected)
                } else {
                    FridaySymbolImage(systemName: "square.grid.2x2").font(.system(size: 11))
                        .frame(width: TaskSidebarLayout.iconSize, height: TaskSidebarLayout.iconSize)
                    Text(friday: "全部 Workspace").lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("\(TaskWorkspaces.tasks(store.tasks, scope: scope, projects: store.projects).count)")
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    .fixedSize()
            }
            .font(.callout.weight(.medium))
            .padding(.leading, TaskSidebarLayout.rowInset).padding(.trailing, 8)
            .frame(maxWidth: .infinity).frame(height: 28)
            #if os(macOS)
            if store.deviceId == "owner" {
                Button(action: chooseDirectory) {
                    FridaySymbolImage(systemName: "folder.badge.plus").frame(width: 28, height: 28)
                }.buttonStyle(FridaySymbolButtonStyle())
                    .help(Text(friday: "添加 Workspace"))
                    .accessibilityLabel(Text(friday: "添加 Workspace"))
                    .disabled(adding || !store.connected)
            }
            #endif
            Button(action: newTask) {
                FridaySymbolImage(systemName: "square.and.pencil").frame(width: 28, height: 28)
            }.buttonStyle(FridaySymbolButtonStyle())
                .help(Text(friday: "新任务"))
                .accessibilityLabel(Text(friday: "新任务"))
        }.padding(.leading, TaskSidebarLayout.listInset).padding(.trailing, 12).padding(.vertical, 8)
            .popover(item: $editingWorkspace, arrowEdge: .bottom) {
                WorkspaceIdentityEditor(store: store, project: $0)
                    .environment(\.locale, locale)
            }
    }

    private func taskList(scope: String?) -> some View {
        let tasks = TaskWorkspaces.tasks(store.tasks, scope: scope, projects: store.projects)
        let collapsed = collapsedWorkspaceGroups
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
                if scope == nil {
                    let groups = TaskWorkspaces.groups(store.tasks, projects: store.projects)
                    ForEach(groups) { group in
                        Section {
                            if !collapsed.contains(group.id) {
                                ForEach(group.tasks) { task in taskButton(task) }
                            }
                        } header: {
                            workspaceGroupHeader(group, collapsed: collapsed.contains(group.id))
                                .padding(.top, group.id == groups.first?.id ? 0 : 4)
                        }
                    }
                } else {
                    ForEach(tasks) { task in taskButton(task) }
                }
            }.padding(.horizontal, TaskSidebarLayout.listInset).padding(.bottom, 12)
        }
    }

    private func workspaceGroupHeader(_ group: TaskWorkspaces.Group, collapsed: Bool) -> some View {
        Button { toggleWorkspaceGroup(group.id) } label: {
            HStack(spacing: TaskSidebarLayout.iconSpacing) {
                WorkspaceIcon(name: group.name, icon: group.project?.icon, color: group.project?.color, size: TaskSidebarLayout.iconSize)
                Text(fridayString: group.name).lineLimit(1)
                Spacer(minLength: 0)
                FridaySymbolImage(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                    .frame(width: 12).accessibilityHidden(true)
            }
            .font(.system(size: 14, weight: .medium)).foregroundStyle(.primary)
            .frame(minHeight: 24).padding(.horizontal, TaskSidebarLayout.rowInset).contentShape(Rectangle())
        }
        .buttonStyle(WorkspaceTitleButtonStyle())
        .padding(.top, 8).padding(.bottom, 2)
        .accessibilityLabel(Text(fridayString: group.name))
        .accessibilityValue(Text(fridayString: collapsed ? "已收起" : "已展开"))
        .accessibilityHint(Text(fridayString: collapsed ? "展开任务" : "收起任务"))
        .accessibilityAddTraits(.isHeader)
        .help(Text(fridayString: collapsed ? "展开任务" : "收起任务"))
    }

    private func toggleWorkspaceGroup(_ id: String) {
        var collapsed = collapsedWorkspaceGroups
        if !collapsed.insert(id).inserted { collapsed.remove(id) }
        guard let data = try? JSONEncoder().encode(collapsed.sorted()) else { return }
        withAnimation(motion) { collapsedWorkspaceData = data }
    }

    private func taskButton(_ task: WorkItem) -> some View {
        Button { selectedTask = task.id } label: {
            TaskRow(task: task, workspaceName: TaskWorkspaces.name(for: task, in: store.projects), selected: selectedTask == task.id, showsWorkspace: false)
                .padding(.horizontal, TaskSidebarLayout.rowInset).foregroundStyle(.primary)
        }.buttonStyle(TaskRowButtonStyle(selected: selectedTask == task.id))
            .accessibilityAddTraits(selectedTask == task.id ? .isSelected : [])
            .help("\(task.title)\n\(task.cwd)")
    }

    private var footer: some View {
        VStack(spacing: 8) {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        ForEach(pages.indices, id: \.self) { page in
                            let title = pages[page].flatMap { id in store.projects.first { $0.id == id }?.name } ?? "全部 Workspace"
                            Button { select(pages[page]) } label: {
                                FridaySymbolImage(systemName: "circle.fill")
                                    .font(.system(size: page == index ? 8 : 6))
                                    .foregroundStyle(page == index ? .primary : .tertiary)
                                    .frame(width: 24, height: 28).contentShape(Rectangle())
                            }.buttonStyle(FridaySymbolButtonStyle())
                                .accessibilityLabel(Text(fridayString: title))
                                .accessibilityAddTraits(page == index ? .isSelected : [])
                                .help(Text(fridayString: title)).id(page)
                        }
                    }.frame(minWidth: 100)
                }.fixedSize(horizontal: false, vertical: true)
                    .defaultScrollAnchor(.center)
                    .onChange(of: index) { _, value in withAnimation(motion) { proxy.scrollTo(value, anchor: .center) } }
            }.frame(maxWidth: CGFloat(pages.count * 26 + 8))
        }.padding(.horizontal, 16).padding(.bottom, 12)
    }

    private func select(_ id: String?) {
        withAnimation(motion) { scope = id; drag = 0 }
        draftProjectId = id
    }

    private func reconcileWorkspaces() {
        // A disconnected/initial cache cannot establish that a Workspace is gone.
        guard store.connected else { return }
        let ids = store.projects.map(\.id)
        if let scope, !ids.contains(scope) { select(nil) }
        if let draftProjectId, !ids.contains(draftProjectId) { self.draftProjectId = nil }
    }

    #if os(macOS)
    private func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if let existing = store.projects.first(where: { URL(fileURLWithPath: $0.path).standardizedFileURL == url.standardizedFileURL }) {
            select(existing.id); return
        }
        adding = true; error = nil
        Task {
            defer { adding = false }
            do {
                let project = try await store.connection.decode(Project.self, "/api/projects", method: "POST", body: ["name": url.lastPathComponent, "path": url.path])
                await store.refresh()
                select(project.id)
            } catch { self.error = error.localizedDescription }
        }
    }
    #endif
}
