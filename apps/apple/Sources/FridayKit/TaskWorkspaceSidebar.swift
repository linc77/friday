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
    @State private var picker: WorkspacePickerPurpose?
    @State private var adding = false
    @State private var error: String?
    @State private var drag: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.locale) private var locale

    private var pages: [String?] { [nil] + store.projects.map { Optional($0.id) } }
    private var index: Int { pages.firstIndex(of: scope) ?? 0 }
    private var project: Project? { store.projects.first { $0.id == scope } }
    private var draftProject: Project? { store.projects.first { $0.id == draftProjectId } }
    private var motion: Animation? { reduceMotion || scenePhase != .active ? nil : FridayTheme.motion }

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
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Text(friday: "任务").font(.headline)
                Spacer()
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
            }
            Button { picker = .filter } label: {
                HStack(spacing: 8) {
                    FridaySymbolImage(systemName: project == nil ? "square.grid.2x2" : "folder")
                    if let project { Text(project.name).lineLimit(1) }
                    else { Text(friday: "全部 Workspace") }
                    Spacer(minLength: 0)
                    Text("\(TaskWorkspaces.tasks(store.tasks, scope: scope, projects: store.projects).count)")
                        .font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                    FridaySymbolImage(systemName: "chevron.down").font(.system(size: 9))
                }
                .font(.callout.weight(.medium)).padding(.horizontal, 10).padding(.vertical, 9)
                .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
            }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "切换 Workspace"))
                .accessibilityValue(Text(fridayString: project?.name ?? "全部 Workspace"))
                .popover(isPresented: pickerBinding(.filter), arrowEdge: .bottom) { workspacePicker(.filter) }
            if selectedTask == nil {
                Button { picker = .draft } label: {
                    HStack(spacing: 5) {
                        Text(friday: "新任务").foregroundStyle(.tertiary)
                        Text("·").foregroundStyle(.tertiary)
                        if let draftProject { Text(draftProject.name).lineLimit(1) }
                        else { Text(friday: "选择 Workspace") }
                        Spacer(minLength: 0)
                        FridaySymbolImage(systemName: "chevron.down").font(.system(size: 8))
                    }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 3)
                        .padding(.vertical, 2).contentShape(Rectangle())
                }.buttonStyle(FridaySymbolButtonStyle())
                    .accessibilityLabel(Text(friday: "新任务 Workspace"))
                    .accessibilityValue(Text(fridayString: draftProject?.name ?? "选择 Workspace"))
                    .help(draftProject?.path ?? "Workspace")
                    .popover(isPresented: pickerBinding(.draft), arrowEdge: .bottom) { workspacePicker(.draft) }
            }
        }.padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 14)
    }

    private func taskList(scope: String?) -> some View {
        let tasks = TaskWorkspaces.tasks(store.tasks, scope: scope, projects: store.projects)
        return ScrollView {
            LazyVStack(spacing: 4) {
                if tasks.isEmpty {
                    VStack(spacing: 9) {
                        Text(friday: "这个 Workspace 还没有任务")
                            .font(.callout.weight(.medium))
                        Text(friday: "点击上方新任务按钮开始。")
                            .font(.caption).foregroundStyle(.secondary)
                    }.multilineTextAlignment(.center).padding(.horizontal, 20).padding(.top, 44)
                }
                ForEach(tasks) { task in
                    Button { selectedTask = task.id } label: {
                        TaskRow(task: task, workspaceName: TaskWorkspaces.name(for: task, in: store.projects))
                            .padding(.horizontal, 12).foregroundStyle(.primary)
                            .background(selectedTask == task.id ? FridayTheme.surface : .clear, in: RoundedRectangle(cornerRadius: 10))
                            .contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .accessibilityAddTraits(selectedTask == task.id ? .isSelected : [])
                        .help(task.cwd)
                }
            }.padding(.horizontal, 8).padding(.bottom, 12)
        }
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
        if let id { draftProjectId = id }
    }

    private func reconcileWorkspaces() {
        // A disconnected/initial cache cannot establish that a Workspace is gone.
        guard store.connected else { return }
        let ids = store.projects.map(\.id)
        if let scope, !ids.contains(scope) { select(nil) }
        if let draftProjectId, !ids.contains(draftProjectId) { self.draftProjectId = nil }
    }

    private func pickerBinding(_ purpose: WorkspacePickerPurpose) -> Binding<Bool> {
        Binding(get: { picker == purpose }, set: { picker = $0 ? purpose : nil })
    }

    private func workspacePicker(_ purpose: WorkspacePickerPurpose) -> some View {
        WorkspacePicker(projects: store.projects, selection: purpose == .filter ? scope : draftProjectId, includesAll: purpose == .filter) { id in
            picker = nil
            if purpose == .filter { select(id) }
            else { draftProjectId = id }
        }.environment(\.locale, locale)
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

private enum WorkspacePickerPurpose: String, Identifiable {
    case filter, draft
    var id: String { rawValue }
}

struct WorkspacePicker: View {
    let projects: [Project]
    let selection: String?
    var includesAll = false
    let select: (String?) -> Void
    @State private var search = ""

    private var matches: [Project] {
        projects.filter { search.isEmpty || $0.name.localizedStandardContains(search) || $0.path.localizedStandardContains(search) }
    }

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                FridaySymbolImage(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(friday: "搜索 Workspace…", text: $search).textFieldStyle(.plain)
            }.padding(8)
            Divider()
            ScrollView {
                VStack(spacing: 3) {
                    if includesAll && search.isEmpty { row(id: nil, name: "全部 Workspace", path: nil) }
                    ForEach(matches) { project in row(id: project.id, name: project.name, path: project.path) }
                    if matches.isEmpty {
                        Text(friday: "没有匹配的 Workspace").font(.callout).foregroundStyle(.secondary).padding(16)
                    }
                }
            }.frame(maxHeight: 300)
        }.padding(10).frame(width: 310)
    }

    private func row(id: String?, name: String, path: String?) -> some View {
        Button { select(id) } label: {
            HStack(spacing: 10) {
                FridaySymbolImage(systemName: id == nil ? "square.grid.2x2" : "folder").frame(width: 18)
                VStack(alignment: .leading, spacing: 3) {
                    Text(fridayString: name).lineLimit(1)
                    if let path { Text(path).font(.caption2).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle) }
                }
                Spacer(minLength: 2)
                if selection == id { FridaySymbolImage(systemName: "checkmark").font(.caption) }
            }.padding(9).frame(maxWidth: .infinity, alignment: .leading)
                .background(selection == id ? Color.primary.opacity(0.06) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                .contentShape(Rectangle())
        }.buttonStyle(FridaySymbolButtonStyle()).help(path ?? name)
            .accessibilityAddTraits(selection == id ? .isSelected : [])
    }
}
