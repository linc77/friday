import SwiftUI
#if os(macOS)
import AppKit
#endif

struct TaskFilesPanel: View {
    @ObservedObject var store: FridayStore
    @ObservedObject private var editors = FileEditorStore.shared
    @StateObject private var hostEditors = TaskHostEditorModel()
    let task: WorkItem
    @Binding var state: TaskFilesPanelState
    @AppStorage("friday.files.renderMarkdown") private var renderMarkdown = true
    @AppStorage("friday.files.renderHTML") private var renderHTML = true
    @AppStorage("friday.files.renderTable") private var renderTable = true
    @AppStorage("friday.files.wrap") private var wrapping = true
    @State private var entries: [String: [TaskFileEntry]] = [:]
    @State private var loadedGeneration: [String: Int] = [:]
    @State private var expandAll = false
    @State private var hostExpanded: Set<String> = [""]
    @Environment(\.taskFileMentionBridge) private var fileMentionBridge
    @State private var truncated: Set<String> = []
    @State private var query = ""
    @State private var selectionOrigin = TaskFileTreeSelectionOrigin()
    @State private var matches: [TaskFileEntry] = []
    @State private var matchesQuery = ""
    @State private var searching = false
    @State private var listingError: String?
    @State private var directoryLoading: String?
    @State private var refresh = 0
    @State private var document: TaskFileDocument?
    @State private var loadedKey = ""
    @State private var documentError: String?
    @State private var previewError: String?
    @State private var browserURL: URL?
    @State private var browserLoadedKey = ""
    @State private var mediaLinkFailed = false
    @State private var sourceOverride = false
    @State private var imagePreview: MarkdownImagePreview?
    @State private var copied = false
    @State private var copyID = UUID()
    private var identity: String { store.connectionIdentity + ":" + task.id + ":" + task.cwd }
    private var revision: String { (task.runs?.last?.id ?? "") + ":" + (task.runs?.last?.status ?? task.status) }
    private var documentKey: String { identity + ":" + (state.selected ?? "") + ":" + revision + ":\(refresh)" }
    private var browseRoot: String? { folderView && state.selected?.hasPrefix("/") == true ? state.selected : nil }
    private var treeIdentity: String { identity + ":tree:" + (browseRoot ?? "workspace") }
    private var treeExpanded: Set<String> { browseRoot == nil ? state.expanded : hostExpanded }
    private var treeKey: String { treeIdentity + ":" + treeExpanded.sorted().joined(separator: "\0") + ":\(refresh):\(!TaskFileTreeSearch.normalize(query).isEmpty)" }
    private var searchKey: String { treeIdentity + ":" + query + ":\(refresh)" }
    private var serverMatches: [TaskFileEntry] { matchesQuery == query && !searching ? matches : [] }
    private var visibleMatches: [TaskFileEntry] { TaskFileTreeSearch.matching(entries.values.flatMap { $0 } + (browseRoot == nil ? serverMatches : []), query: query) }
    private var treeSelection: String? {
        if let root = browseRoot { guard let trail = tab?.trail, let relative = TaskHostPath.relative(trail, root: root) else { return nil }; return relative.split(separator: "/").first.map(String.init) }
        guard let path = state.selected, !path.isEmpty else { return nil }
        return path.hasPrefix("/") ? TaskHostPath.relative(path, root: task.cwd) : path
    }
    private var directoryPaths: Set<String> { Set(entries.values.flatMap { $0 }.filter { $0.kind == "directory" }.map(\.path)) }
    private var allExpanded: Bool { !directoryPaths.isEmpty && directoryPaths.isSubset(of: treeExpanded) }
    private var mentionScope: String { TaskFileMentionPayload.scope(server: store.connection.server, token: store.connection.token, cwd: task.cwd, serviceId: store.serviceId) }
    private var editorKey: String { FileEditorStore.key(server: store.connection.server, token: store.connection.token, cwd: task.cwd, path: state.selected ?? "") }
    private var editor: FileEditSession? { state.selected == nil ? nil : editors.current(editorKey) }
    private var displayedDocument: TaskFileDocument? { editor?.document ?? (loadedKey == editorKey ? document : nil) }
    private var folderView: Bool { state.folderView }
    private var tableDelimiter: UInt16? { displayedDocument.flatMap { TaskDelimitedTable.delimiter(name: $0.path, mimeType: $0.mimeType) } }
    private var canRender: Bool { !folderView && (["markdown", "html"].contains(displayedDocument?.kind ?? "") || displayedDocument?.contents != nil && tableDelimiter != nil) }
    private var rendered: Bool { !folderView && !sourceOverride && (displayedDocument?.kind == "markdown" ? renderMarkdown : tableDelimiter != nil ? renderTable : displayedDocument?.kind == "html" ? renderHTML : false) }
    private var tab: TaskFileTab? { state.tab }
    private var revealKey: String { identity + ":" + (tab?.path ?? "") + ":\(tab?.line ?? 0):\(tab?.reveal ?? 0)" }
    private var browserKey: String { editorKey + ":" + (displayedDocument?.version ?? "") + ":" + String(rendered) + ":\(refresh)" }
    private var playbackURL: URL? { browserLoadedKey == editorKey ? browserURL : nil }

    var body: some View {
        VStack(spacing: 0) {
            if let tab, !tab.path.isEmpty || tab.trail != nil {
                HStack(spacing: 10) {
                    TaskFileBreadcrumbs(store: store, task: task, path: tab.path, trail: TaskFileBreadcrumb.retained(tab.trail, at: tab.path), revision: revision + ":\(refresh)", openFile: { state.open($0) }, navigate: { path, trail in state.navigate(path, trail: trail, keepSource: !folderView) })
                    Spacer(minLength: 0)
                    TaskOpenInControl(store: store, task: task, path: tab.path, line: tab.line)
                    if !folderView, let editor, editor.canEdit {
                        Text(friday: editor.phase == "saving" ? "正在保存" : editor.phase == "saved" ? "已保存" : editor.error == nil ? "未保存" : "保存未完成").font(.caption2).foregroundStyle(editor.error == nil ? Color.secondary : .orange)
                        Button { editor.flush() } label: { FridaySymbolImage(systemName: "square.and.arrow.down") }.disabled(!editor.isDirty || editor.isSaving || !editor.rootMatches).keyboardShortcut("s", modifiers: .command).accessibilityLabel(Text(friday: "保存文件"))
                    }
                    if canRender {
                        Button { toggleRendered() } label: { FridaySymbolImage(systemName: rendered ? "chevron.left.forwardslash.chevron.right" : "eye") }
                            .help(Text(friday: rendered ? "显示源代码" : "显示预览")).accessibilityLabel(Text(friday: rendered ? "显示源代码" : "显示预览"))
                    }
                    if !folderView, !rendered, displayedDocument?.contents != nil {
                        Button { wrapping.toggle() } label: { FridaySymbolImage(systemName: "text.wrap") }.foregroundStyle(wrapping ? FridayTheme.accent : .secondary).accessibilityLabel(Text(friday: "代码自动换行"))
                        Button { if let contents = editor?.contents ?? displayedDocument?.contents { copy(contents) } } label: { FridaySymbolImage(systemName: copied ? "checkmark" : "doc.on.doc") }.accessibilityLabel(Text(friday: copied ? "已复制" : "复制源代码"))
                    }
                    if !folderView { Button { state.explorerShown.toggle() } label: { FridaySymbolImage(systemName: "sidebar.left") }.foregroundStyle(state.explorerShown ? FridayTheme.accent : .secondary).accessibilityLabel(Text(friday: "显示文件树")) }
                    Button { reload() } label: { FridaySymbolImage(systemName: "arrow.clockwise") }.disabled(!store.connected).accessibilityLabel(Text(friday: "刷新文件"))
                }.buttonStyle(FridaySymbolButtonStyle()).padding(12)
                Divider()
            }
            if folderView {
                if let documentError {
                    HStack {
                        Text(fridayString: documentError).font(.caption).foregroundStyle(.orange)
                        if let editor, editor.isDirty { Button(friday: "复制编辑内容") { copy(editor.contents) }.buttonStyle(FridayButtonStyle(compact: true)) }
                    }.padding(10)
                }
                explorer
            }
            else {
                HStack(spacing: 0) {
                    if state.explorerShown { explorer.frame(minWidth: 130, idealWidth: 170, maxWidth: 210); Divider() }
                    fileContent.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .task(id: treeKey) {
            directoryLoading = nil
            guard TaskFileTreeSearch.normalize(query).isEmpty else { return }
            let scope = treeIdentity, root = browseRoot
            for path in treeExpanded.union([""]).sorted(by: { $0.count < $1.count }) where entries[path] == nil || loadedGeneration[path] != refresh {
                guard !Task.isCancelled else { return }; directoryLoading = path
                do {
                    let requested = root.map { TaskHostPath.absolute(path, root: $0) } ?? path
                    let result = try await store.connection.decode(TaskFileListing.self, "/api/task-files?" + TaskContextScope(taskID: task.id).query + "&path=" + encode(requested))
                    guard !Task.isCancelled, treeIdentity == scope else { return }
                    let children: [TaskFileEntry] = root.map { root in result.entries.compactMap { entry in TaskHostPath.relative(entry.path, root: root).map { TaskFileEntry(path: $0, name: entry.name, kind: entry.kind, ignored: entry.ignored) } } } ?? result.entries
                    let prefix = path.isEmpty ? "" : path + "/", allowed = Set(children.filter { $0.kind == "directory" }.map(\.path))
                    for child in Array(entries.keys) where child != path && child.hasPrefix(prefix) {
                        let head = String(child.dropFirst(prefix.count).split(separator: "/").first ?? "")
                        if !allowed.contains(prefix + head) { entries.removeValue(forKey: child); loadedGeneration.removeValue(forKey: child); updateExpanded { $0.remove(child) } }
                    }
                    entries[path] = children; loadedGeneration[path] = refresh
                    if result.truncated { truncated.insert(path) } else { truncated.remove(path) }
                    listingError = nil
                } catch { if !Task.isCancelled, treeIdentity == scope { listingError = error.localizedDescription } }
            }
            if !Task.isCancelled { directoryLoading = nil }
        }
        .task(id: searchKey) {
            matches = []; guard !query.isEmpty, browseRoot == nil else { searching = false; return }; searching = true
            let requested = query, source = searchKey
            do {
                try await Task.sleep(for: .milliseconds(120))
                let result = try await store.connection.decode(TaskFileListing.self, "/api/task-files?" + TaskContextScope(taskID: task.id).query + "&search=" + encode(requested))
                guard !Task.isCancelled, searchKey == source else { return }; matches = result.entries; matchesQuery = requested; searching = false
            } catch { if !Task.isCancelled { listingError = error.localizedDescription; searching = false } }
        }
        .task(id: documentKey) {
            documentError = nil
            guard let path = state.selected else { return }
            let key = editorKey, scope = identity, readRevision = editors.current(editorKey)?.revisionForRead
            do {
                let transport = try FileEditorTransport.captured(store: store, taskID: task.id, path: path)
                let value = try await store.connection.decode(TaskFileDocument.self, TaskFileNavigation.route("document", taskID: task.id, path: path))
                guard !Task.isCancelled, identity == scope, editorKey == key else { return }
                if value.kind == "directory" {
                    if editors.current(key)?.isDirty == true { documentError = "当前路径已变为文件夹，编辑内容已保留" }
                    else { state.classify(path, directory: true); editors.current(key)?.accept(value, readRevision: readRevision) }
                } else { state.classify(path, directory: false) }
                if value.contents != nil, value.writeSupported == true, value.workspaceVersion != nil, !value.truncated {
                    _ = await editors.open(key: key, document: value, transport: transport, readRevision: readRevision)
                    guard !Task.isCancelled, identity == scope, editorKey == key else { return }
                }
                document = value; loadedKey = key
            } catch { if !Task.isCancelled, editorKey == key { documentError = error.localizedDescription } }
        }
        .task(id: browserKey) {
            previewError = nil; mediaLinkFailed = false
            let media = ["audio", "video"].contains(displayedDocument?.kind ?? "")
            if !media || browserLoadedKey != editorKey { browserURL = nil }
            guard let document = displayedDocument, media || document.kind == "pdf" || document.kind == "html" && rendered else { return }
            let requestKey = browserKey, fileKey = editorKey
            do {
                let asset = try await store.connection.decode(TaskFileAssetURL.self, "/api/task-files/asset-url", method: "POST", body: ["scope": ["taskId": task.id], "path": document.path, "workspaceRoot": task.cwd])
                guard !Task.isCancelled, browserKey == requestKey, editorKey == fileKey else { return }
                guard asset.url.hasPrefix("/file-assets/"), let url = try store.connection.request(asset.url).url else { throw URLError(.badURL) }
                browserURL = url; browserLoadedKey = fileKey
            } catch {
                if !Task.isCancelled, browserKey == requestKey, editorKey == fileKey {
                    if document.kind == "video", playbackURL != nil { mediaLinkFailed = true }
                    else { previewError = error.localizedDescription }
                }
            }
        }
        .onChange(of: revealKey, initial: true) { _, _ in sourceOverride = !folderView && tab?.line != nil; if selectionOrigin.revealClearsSearch(tab?.path) { query = "" } }
        .onAppear { if state.visible && state.selected == nil { state.open("") } }
        .onChange(of: editorKey) { old, _ in editors.flush(old); documentError = nil; previewError = nil; browserURL = nil; browserLoadedKey = "" }
        .onChange(of: displayedDocument?.kind) { _, kind in if kind == "directory", let path = state.selected, editor?.isDirty != true { state.classify(path, directory: true) } }
        .onDisappear { editors.flush(editorKey) }
        .onChange(of: revision) { _, _ in reload() }
        .onChange(of: store.connected) { _, connected in if connected { reload() } }
        .onChange(of: directoryPaths) { _, paths in if expandAll, browseRoot == nil { state.expanded.formUnion(paths) } }
        .onChange(of: treeIdentity) { _, _ in entries = [:]; loadedGeneration = [:]; hostExpanded = [""]; expandAll = false; truncated = []; matches = []; query = ""; listingError = nil }
        .onChange(of: identity) { _, _ in entries = [:]; loadedGeneration = [:]; expandAll = false; truncated = []; matches = []; document = nil; imagePreview = nil }
        .task(id: identity + ":editors:" + String(store.connected)) {
            guard store.connected else { return }
            if let transport = try? TaskHostEditorTransport.task(store: store, task: task) { await hostEditors.load(identity: identity, root: task.cwd, transport: transport) }
        }
        .onChange(of: hostEditors.error) { _, error in if let error { listingError = error } }
        .sheet(item: $imagePreview) { preview in MarkdownImageGalleryView(preview: preview, workspacePath: task.cwd, canOpenLocalFiles: store.deviceId == "owner") }
        .task(id: copyID) { if copied { try? await Task.sleep(for: .milliseconds(1200)); if !Task.isCancelled { copied = false } } }
    }
    private var explorer: some View {
        let root = browseRoot, source = treeIdentity
        return VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField(friday: "搜索文件", text: $query).textFieldStyle(.plain).font(.callout)
                if searching || directoryLoading != nil { ProgressView().controlSize(.small) }
                if !directoryPaths.isEmpty, root == nil {
                    Button { expandAll = !(expandAll || allExpanded); if expandAll { state.expanded.formUnion(directoryPaths) } else { state.expanded = [""] } } label: { FridaySymbolImage(systemName: allExpanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") }.accessibilityLabel(Text(friday: allExpanded ? "收起所有文件夹" : "展开所有文件夹"))
                }
                Button { reload() } label: { FridaySymbolImage(systemName: "arrow.clockwise") }.disabled(!store.connected).accessibilityLabel(Text(friday: "刷新文件"))
            }.buttonStyle(FridaySymbolButtonStyle()).padding(12)
            Divider()
            TaskFileBrowserTree(entries: entries, matches: browseRoot == nil ? serverMatches : [], query: query, expanded: treeExpanded, selected: treeSelection,
                reveal: revealKey, scope: mentionScope, mentionRoot: root, open: { path in
                    guard treeIdentity == source else { return }; let path = root.map { TaskHostPath.absolute(path, root: $0) } ?? path
                    selectionOrigin.openedFromTree(path); state.open(path)
                }, toggle: { item, expanded in
                    guard treeIdentity == source else { return }
                    if expanded { updateExpanded { $0.formUnion(item.chain) } } else { expandAll = false; updateExpanded { $0.subtract(item.chain) } }
                }, menu: { entry in guard treeIdentity == source else { return [] }; return fileMenu(root.map { TaskHostPath.entry(entry, root: $0) } ?? entry) }, clearSearch: { query = "" }, copyMentions: { values in guard treeIdentity == source else { return }; copyMentions(root.map { root in values.map { TaskHostPath.entry($0, root: root) } } ?? values) })
                .id(source)
            if let error = listingError { Text(fridayString: error).font(.caption).foregroundStyle(.orange).padding(12) }
            if !truncated.isEmpty { Text(friday: "文件夹条目较多，可使用搜索定位文件").font(.caption).foregroundStyle(.secondary).padding(12) }
            if entries[""]?.isEmpty == true, query.isEmpty { Text(friday: "文件夹为空").font(.caption).foregroundStyle(.secondary).padding(16) }
            if !TaskFileTreeSearch.normalize(query).isEmpty, !searching, visibleMatches.isEmpty { Text(friday: "未找到文件或目录").font(.caption).foregroundStyle(.secondary).padding(12) }
            if copied { Text(friday: "已复制").font(.caption).foregroundStyle(.secondary).padding(8) }
        }
    }
    @ViewBuilder private var fileContent: some View {
        if let error = documentError ?? previewError, editor == nil || previewError != nil {
            VStack(spacing: 12) { Text(fridayString: error).font(.callout).foregroundStyle(.orange).textSelection(.enabled); Button(friday: "重新加载") { reload() }.buttonStyle(FridayButtonStyle(compact: true)) }.padding(24)
        } else if let document = displayedDocument {
            VStack(spacing: 0) {
                if let documentError { Text(fridayString: documentError).font(.caption).foregroundStyle(.orange).textSelection(.enabled).padding(10) }
                if let editor, let error = editor.error {
                    HStack(spacing: 10) {
                        Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                        Spacer(minLength: 0)
                        Button(friday: "复制编辑内容") { copy(editor.contents) }
                        if editor.rootMatches {
                            Button(friday: "核对保存结果") { editor.reconcile() }.disabled(editor.isSaving)
                            Button(friday: "重新保存") { editor.retry() }.disabled(editor.isSaving)
                        } else {
                            Button(friday: "复制编辑并读取当前文件") { copy(editor.contents); Task { await editor.readReplacedWorkspace() } }.disabled(editor.isSaving)
                        }
                    }.buttonStyle(FridayButtonStyle(compact: true)).padding(10)
                    Divider()
                }
                if document.truncated { Text(friday: "仅显示文件前 1 MiB 的内容").font(.caption).foregroundStyle(.secondary).padding(8) }
                if (document.kind == "html" && rendered) || document.kind == "pdf" {
                    if let browserURL { TaskWorkspaceDocumentView(url: browserURL, pdf: document.kind == "pdf", failure: { previewError = $0 }).id(identity + ":" + document.version + ":\(refresh)") }
                    else { ProgressView().controlSize(.small) }
                } else if ["audio", "video"].contains(document.kind) {
                    if let playbackURL { TaskWorkspaceMediaView(url: playbackURL, revision: document.version + ":" + revision + ":\(refresh)", name: tab?.name ?? document.path, video: document.kind == "video", sourceFailed: mediaLinkFailed, failure: { previewError = $0 }, actions: document.kind == "video" ? .workspace(store: store, task: task, path: document.path, kind: .video) : nil).id(editorKey) }
                    else { ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity) }
                } else if document.kind == "image" {
                    let image = MarkdownImage(source: URL(fileURLWithPath: TaskHostPath.absolute(document.path, root: task.cwd)).absoluteString, alt: document.path, title: nil, link: nil)
                    VStack(spacing: 8) {
                        HStack { Spacer(); Button { imagePreview = MarkdownImagePreview(images: [image], index: 0) } label: { FridaySymbolImage(systemName: "arrow.up.left.and.arrow.down.right") }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "展开图片")) }.padding(10)
                        MarkdownImageView(image: image, canOpenLocalFiles: store.deviceId == "owner", workspacePath: task.cwd, expanded: true, refresh: refresh).id(document.version)
                    }
                } else if let contents = editor?.contents ?? document.contents {
                    if document.kind == "markdown", rendered {
                        ScrollViewReader { proxy in
                            ScrollView { AgentMarkdown(text: contents, canOpenLocalFiles: store.deviceId == "owner", workspacePath: URL(fileURLWithPath: TaskHostPath.absolute(document.path, root: task.cwd)).deletingLastPathComponent().path).padding(18) }
                                .environment(\.markdownScrollTo, { proxy.scrollTo($0, anchor: .top) })
                                .environment(\.markdownTaskToggle, editor?.canEdit == true ? { [editor] offset, checked in
                                    editor?.setTaskChecked(at: offset, checked: checked, source: contents)
                                } : nil)
                        }
                    } else if let tableDelimiter, rendered { TaskDelimitedTableView(name: tab?.name ?? document.path, text: contents, delimiter: tableDelimiter) }
                    else { TaskAnnotatedSourceFileView(source: contents, language: document.language, identity: editorKey, line: tab?.line, reveal: tab?.reveal ?? 0, wrapping: wrapping, editable: editor?.canEdit == true, path: document.path, workspaceRoot: task.cwd, workspaceVersion: document.workspaceVersion ?? "", bridge: fileMentionBridge ?? TaskFileMentionBridge(), change: { [editor] text in editor?.change(text) }).id(editorKey) }
                } else { VStack(spacing: 10) { FridaySymbolImage(systemName: "doc"); Text(friday: "此文件暂不支持预览").font(.callout); Text(ByteCountFormatter.string(fromByteCount: Int64(document.sizeBytes), countStyle: .file)).font(.caption).foregroundStyle(.secondary) }.padding(24) }
            }
        } else { ProgressView().controlSize(.small) }
    }
    private func toggleRendered() {
        let next = !rendered; sourceOverride = false; previewError = nil
        if displayedDocument?.kind == "markdown" { renderMarkdown = next } else if tableDelimiter != nil { renderTable = next } else { renderHTML = next }
    }
    private func fileMenu(_ entry: TaskFileEntry) -> [TaskFileTreeMenuItem] {
        var items = [TaskFileTreeMenuItem(title: String(localized: "复制相对路径", bundle: .module), symbol: "doc.on.doc", action: { copy(entry.path) }),
         TaskFileTreeMenuItem(title: String(localized: "复制绝对路径", bundle: .module), symbol: "doc.on.doc", action: { copy(TaskHostPath.absolute(entry.path, root: task.cwd)) }),
         TaskFileTreeMenuItem(title: String(localized: "复制引用", bundle: .module), symbol: "link", action: { copyMentions([entry]) }),
         TaskFileTreeMenuItem(title: String(localized: "添加到输入框", bundle: .module), symbol: "text.badge.plus", enabled: fileMentionBridge?.context?.enabled == true, action: {
             let payload = TaskFileMentionPayload(scope: mentionScope, entries: [TaskFileMention(entry)])
             guard let data = payload.data, fileMentionBridge?.context?.receive(data) == true else { listingError = "输入框尚未准备好接收引用"; return }
         })]
        if let snapshot = hostEditors.snapshot, TaskFileMention(entry).valid {
            let enabled = store.connected && !hostEditors.busy
            let sourceIdentity = identity
            let launch: (String, Bool) -> Void = { editor, reveal in
                guard store.connected, identity == sourceIdentity else { return }
                _ = hostEditors.open(TaskHostEditorAction(path: entry.path, editor: editor, reveal: reveal), identity: sourceIdentity)
            }
            var opening: [TaskFileTreeMenuItem] = []
            if snapshot.editors.contains(where: { $0.id == "file-manager" }) {
                opening.append(TaskFileTreeMenuItem(title: String(localized: "打开", bundle: .module), symbol: "arrow.up.forward.app", enabled: enabled, action: { launch("file-manager", false) }))
                if snapshot.revealSupported { opening.append(TaskFileTreeMenuItem(title: String(localized: "在 Finder 中显示", bundle: .module), symbol: "folder", enabled: enabled, action: { launch("file-manager", true) })) }
            }
            let applications = snapshot.editors.filter { $0.id != "file-manager" }.map { editor in
                TaskFileTreeMenuItem(title: editor.label, symbol: editor.symbol, enabled: enabled, action: { launch(editor.id, false) })
            }
            if !applications.isEmpty { opening.append(TaskFileTreeMenuItem(title: String(localized: "打开方式", bundle: .module), symbol: "arrow.up.forward.app", enabled: enabled, children: applications)) }
            items.insert(contentsOf: opening, at: 0)
        }
        return items
    }
    private func copyMentions(_ entries: [TaskFileEntry]) {
        guard !entries.isEmpty else { return }
        guard entries.count <= 20 else { listingError = "每条消息最多添加 20 个上下文引用"; return }
        TaskFileMentionTransfer.copy(TaskFileMentionPayload(scope: mentionScope, entries: entries.map(TaskFileMention.init)))
        copied = true; copyID = UUID()
    }
    private func reload() { browserURL = nil; browserLoadedKey = ""; refresh += 1; truncated = []; listingError = nil; previewError = nil }
    private func updateExpanded(_ update: (inout Set<String>) -> Void) { if browseRoot == nil { update(&state.expanded) } else { update(&hostExpanded) } }
    private func copy(_ text: String) { copyAgentText(text); copied = true; copyID = UUID() }
    private func encode(_ value: String) -> String { var query = URLComponents(); query.queryItems = [URLQueryItem(name: "x", value: value)]; return String((query.percentEncodedQuery ?? "x=").dropFirst(2)) }
}
