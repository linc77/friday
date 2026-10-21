import SwiftUI

struct TaskFileBreadcrumbs: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem; let path: String; let trail: String; let revision: String
    let openFile: (String) -> Void; let navigate: (String, String) -> Void
    @State private var browsing: String?
    private var project: String { store.projects.first { $0.id == task.projectId }?.name ?? URL(fileURLWithPath: task.cwd).lastPathComponent }
    private var crumbs: [TaskFileBreadcrumb] { TaskFileBreadcrumb.crumbs(project: project, trail: trail) }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 2) {
                    ForEach(Array(crumbs.enumerated()), id: \.element.path) { index, crumb in
                        Group {
                            if crumb.path == TaskFileBreadcrumb.path(path) { Text(verbatim: crumb.label).fontWeight(.medium) }
                            else { Button { let path = TaskHostPath.panel(crumb.path, root: task.cwd); navigate(path, TaskFileBreadcrumb.retained(trail, at: path)) } label: { Text(verbatim: crumb.label) }.buttonStyle(.plain).fridayInteractiveCursor() }
                        }.font(.caption).lineLimit(1).truncationMode(.middle).frame(maxWidth: 160)
                            .foregroundStyle(index > (crumbs.firstIndex { $0.path == TaskFileBreadcrumb.path(path) } ?? index) ? Color.secondary.opacity(0.65) : Color.primary)
                            .help(Text(verbatim: crumb.path.isEmpty ? project : crumb.path)).id(crumb.path)
                            .contextMenu {
                                Button(friday: "复制相对路径") { copyAgentText(crumb.path) }
                                Button(friday: "复制绝对路径") { copyAgentText(TaskHostPath.absolute(crumb.path, root: task.cwd)) }
                            }
                        if index < crumbs.count - 1 {
                            Button { browsing = crumb.path } label: { FridaySymbolImage(systemName: "chevron.right").font(.system(size: 10)).frame(width: 18, height: 20) }
                                .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "浏览文件夹"))
                                .popover(isPresented: Binding(get: { browsing == crumb.path }, set: { if !$0 { browsing = nil } })) {
                                    TaskBreadcrumbContents(store: store, taskID: task.id, project: project, root: crumb.path, currentFile: path, revision: revision, openFile: { browsing = nil; openFile(TaskHostPath.panel($0, root: task.cwd)) })
                                }
                        }
                    }
                }.padding(.vertical, 2)
            }.scrollIndicators(.hidden)
                .onChange(of: path, initial: true) { _, value in browsing = nil; proxy.scrollTo(TaskFileBreadcrumb.path(value), anchor: .trailing) }
                .onChange(of: store.connectionIdentity) { _, _ in browsing = nil }
        }.accessibilityElement(children: .contain).accessibilityLabel(Text(friday: "文件路径"))
    }
}

private struct TaskBreadcrumbContents: View {
    @ObservedObject var store: FridayStore
    let taskID: String; let project: String; let root: String; let currentFile: String; let revision: String
    let openFile: (String) -> Void
    @State private var directory = ""
    @State private var cache: [String: TaskFileListing] = [:]
    @State private var error: String?
    @State private var loading = false
    @State private var refresh = 0
    @State private var selected: String?
    @FocusState private var focused: Bool
    init(store: FridayStore, taskID: String, project: String, root: String, currentFile: String, revision: String, openFile: @escaping (String) -> Void) {
        self.store = store; self.taskID = taskID; self.project = project; self.root = root; self.currentFile = currentFile; self.revision = revision; self.openFile = openFile
        _directory = State(initialValue: root)
    }
    private var listing: TaskFileListing? { cache[directory] }
    private var entries: [TaskFileEntry] { TaskFileBreadcrumb.children(listing?.entries ?? [], of: directory) }
    private var parent: String? { TaskFileBreadcrumb.parent(directory) }
    private var canBack: Bool { directory != root && parent.map { root.isEmpty || $0 == root || $0.hasPrefix(root + "/") } == true }
    private var request: String { store.connectionIdentity + ":" + taskID + ":" + directory + ":" + revision + ":\(refresh)" }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if canBack {
                Button { goBack() } label: { FridaySymbolLabel(friday: "返回上一层", systemImage: "arrow.left").font(.callout).frame(maxWidth: .infinity, alignment: .leading).padding(10) }
                Divider()
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(entries) { entry in
                            Button { activate(entry) } label: {
                                HStack(spacing: 8) {
                                    FridaySymbolImage(systemName: entry.symbol).foregroundStyle(.secondary)
                                    Text(verbatim: entry.name).font(.callout).lineLimit(1).truncationMode(.middle)
                                    Spacer(minLength: 0)
                                    if entry.kind == "directory" { FridaySymbolImage(systemName: "chevron.right").font(.caption2) }
                                    else if entry.path == currentFile { FridaySymbolImage(systemName: "checkmark").font(.caption) }
                                }.padding(.horizontal, 10).padding(.vertical, 7).background(selected == entry.path ? FridayTheme.accent.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 5)).contentShape(Rectangle())
                            }.focusable(false).help(Text(verbatim: entry.path)).id(entry.path)
                                .onHover { if $0 { selected = entry.path } }
                        }
                    }.padding(4)
                }.onChange(of: selected) { _, value in if let value { proxy.scrollTo(value) } }
            }
            if listing == nil, loading { ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(18) }
            if listing != nil, entries.isEmpty { Text(friday: "文件夹为空").font(.caption).foregroundStyle(.secondary).padding(12) }
            if let error { Button { refresh += 1 } label: { Text(fridayString: error).font(.caption).foregroundStyle(.orange).multilineTextAlignment(.leading).padding(10) } }
            if listing?.truncated == true { Text(friday: "部分文件夹条目未显示，可在文件树中搜索。").font(.caption).foregroundStyle(.secondary).padding(10) }
        }.buttonStyle(FridaySymbolButtonStyle()).frame(width: 310, height: min(350, max(80, CGFloat(entries.count) * 33 + (canBack ? 40 : 0) + (error == nil ? 0 : 54) + (listing?.truncated == true ? 48 : 0))))
            .focusable().focused($focused)
            .onAppear { focused = true }
            .onKeyPress(keys: [.upArrow, .downArrow, .leftArrow, .rightArrow, .return]) { key in
                switch key.key {
                case .upArrow: move(-1)
                case .downArrow: move(1)
                case .leftArrow: if canBack { goBack() } else { return .ignored }
                case .rightArrow: if let entry = entries.first(where: { $0.path == selected && $0.kind == "directory" }) { activate(entry) } else { return .ignored }
                case .return: if let entry = entries.first(where: { $0.path == selected }) { activate(entry) } else if error != nil { refresh += 1 }
                default: return .ignored
                }; return .handled
            }
            .task(id: request) {
                let source = store.connectionIdentity, requestedDirectory = directory, requestedRefresh = refresh; loading = true; error = nil
                do {
                    let value = try await store.connection.decode(TaskFileListing.self, TaskFileNavigation.route("", taskID: taskID, path: requestedDirectory))
                    guard !Task.isCancelled, store.connectionIdentity == source, directory == requestedDirectory, refresh == requestedRefresh else { return }; cache[requestedDirectory] = value
                    selected = entries.first(where: { $0.path == currentFile })?.path ?? entries.first?.path
                } catch { if !Task.isCancelled, store.connectionIdentity == source, directory == requestedDirectory, refresh == requestedRefresh { self.error = error.localizedDescription } }
                if !Task.isCancelled, directory == requestedDirectory, refresh == requestedRefresh { loading = false }
            }
    }
    private func activate(_ entry: TaskFileEntry) { if entry.kind == "directory" { directory = entry.path; selected = nil; focused = true } else { openFile(entry.path) } }
    private func goBack() { if canBack, let parent { directory = parent; selected = nil; focused = true } }
    private func move(_ delta: Int) {
        guard !entries.isEmpty else { return }; let index = entries.firstIndex { $0.path == selected } ?? (delta > 0 ? -1 : entries.count)
        selected = entries[min(entries.count - 1, max(0, index + delta))].path
    }
}
