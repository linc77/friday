import SwiftUI

struct TaskChangesPanel: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    @Binding var selection: TaskDiffSelection
    let close: () -> Void
    @AppStorage("friday.taskDiff.split") private var split = false
    @AppStorage("friday.taskDiff.scope") private var scope = "all"
    @State private var snapshot: TaskChangesSnapshot?
    @State private var diff: TaskFileDiff?
    @State private var collapsed: Set<String> = []
    @State private var error: String?
    @State private var diffError: String?
    @State private var loading = false
    @State private var refreshing = false
    @State private var revision = 0
    @State private var refreshGeneration = 0
    @State private var diffGeneration = 0
    @State private var loadedDiffKey: String?
    @Environment(\.taskFileMentionBridge) private var fileMentionBridge
    private var historical: Bool { selection.eventID != nil || selection.runID != nil }
    private var eventHistorical: Bool { selection.eventID != nil && selection.runID == nil }
    private var event: TaskEvent? { task.events.first { $0.id == selection.eventID && $0.revertedAt == nil } }
    private var run: TaskRun? { task.runs?.first { $0.id == selection.runID && $0.revertedAt == nil && $0.executionExcludedAt == nil } }
    private var selectionID: String { selection.runID.map { "run-" + $0 } ?? selection.eventID.map { "event-" + $0 } ?? "current" }
    private var paths: [String] {
        if selection.runID != nil { return run?.changes?.map(\.path) ?? [] }
        return eventHistorical ? event?.changes?.map(\.path) ?? [] : snapshot?.scope == scope ? snapshot?.files.map(\.path) ?? [] : []
    }
    private var path: String? { selection.path.flatMap { paths.contains($0) ? $0 : nil } ?? paths.first }
    private var historicalFile: TaskFileChange? { event?.changes?.first { $0.path == path } }
    private var currentDiff: TaskFileDiff? { loadedDiffKey == requestKey ? diff : nil }
    private var patch: String { eventHistorical ? historicalFile?.diff ?? "" : currentDiff?.patch ?? "" }
    private var truncated: Bool { eventHistorical ? historicalFile?.truncated == true : currentDiff?.truncated == true }
    private var requestKey: String { "\(store.connection.server)|\(task.id)|\(selectionID)|\(historical ? "all" : scope)|\(path ?? "")|\(revision)" }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Menu {
                    Button(friday: "当前工作区改动") { selection = TaskDiffSelection() }
                    let runs = (task.runs ?? []).filter { $0.changes?.isEmpty == false && $0.revertedAt == nil && $0.executionExcludedAt == nil }.reversed()
                    if !runs.isEmpty { Divider() }
                    ForEach(Array(runs)) { item in
                        Button { selection = TaskDiffSelection(runID: item.id, path: item.changes?.first?.path) } label: {
                            HStack {
                                Text(friday: "整轮文件改动")
                                if let date = CodexTranscript.date(item.at) { Text(date, format: .dateTime.month(.twoDigits).day(.twoDigits).hour().minute().second()) }
                            }
                        }
                    }
                    let events = task.events.filter { $0.changes?.isEmpty == false && $0.revertedAt == nil }.reversed()
                    if !events.isEmpty { Divider() }
                    ForEach(Array(events)) { item in
                        Button { selection = TaskDiffSelection(eventID: item.id, path: item.changes?.first?.path) } label: {
                            if let date = CodexTranscript.date(item.at) { Text(date, format: .dateTime.month(.twoDigits).day(.twoDigits).hour().minute().second()) }
                            else { Text(verbatim: item.id) }
                        }
                    }
                } label: { Text(friday: selection.runID != nil ? "整轮文件改动" : historical ? "执行中的文件改动" : "当前工作区改动").font(.callout.weight(.medium)) }
                    .menuStyle(.borderlessButton).fridayInteractiveCursor()
                Spacer(minLength: 0)
                if !historical {
                    Button { Task { await refresh() } } label: { FridaySymbolImage(systemName: "arrow.clockwise") }
                        .buttonStyle(FridaySymbolButtonStyle()).disabled(refreshing || !store.connected).accessibilityLabel(Text(friday: "刷新文件改动"))
                }
                Button(action: close) { FridaySymbolImage(systemName: "xmark") }
                    .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "关闭改动面板"))
            }.padding(12)
            Divider()
            if !historical {
                HStack {
                    Picker(selection: $scope) {
                        Text(friday: "全部").tag("all")
                        Text(friday: "未暂存").tag("working")
                        Text(friday: "已暂存").tag("staged")
                    } label: { Text(friday: "文件改动范围") }.pickerStyle(.segmented).fridayInteractiveCursor()
                }.padding(10)
            } else {
                HStack(spacing: 8) {
                    if let date = CodexTranscript.date(run?.at ?? event?.at) { Text(date, style: .time) }
                    Text(friday: selection.runID != nil ? "执行前后检查点的净改动" : "保存的历史补丁").font(.caption)
                    Spacer()
                }.font(.caption).foregroundStyle(.secondary).padding(10)
            }
            if let error, !historical { panelNotice(error, error: true) }
            if historical && event == nil && run == nil { panelNotice("这次文件改动已经不在任务记录中", error: true) }
            if !paths.isEmpty {
                ScrollView {
                    TaskFileTreeView(paths: paths, cwd: task.cwd, collapsed: $collapsed, selected: path, canOpenLocalFiles: store.deviceId == "owner", open: { selection.path = $0 }) { path in
                        if let file = run?.changes?.first(where: { $0.path == path }) {
                            TaskDiffStat(additions: file.additions, deletions: file.deletions)
                        } else if eventHistorical, let file = event?.changes?.first(where: { $0.path == path }) {
                            TaskDiffStat(additions: file.additions, deletions: file.deletions)
                        } else if let file = snapshot?.files.first(where: { $0.path == path }) {
                            TaskDiffStat(additions: file.additions, deletions: file.deletions)
                        }
                    }.padding(.horizontal, 7).padding(.bottom, 8)
                }.frame(maxHeight: 210)
                Divider()
                diffToolbar
                Divider()
                if let diffError, !eventHistorical { panelNotice(diffError, error: true) }
                if truncated { panelNotice("补丁过大，仅显示部分内容", error: false) }
                if !eventHistorical && currentDiff?.binary == true { empty("二进制文件无法显示文本 Diff", symbol: "doc") }
                else if !patch.isEmpty {
                    TaskAnnotatableDiffView(store: store, bridge: fileMentionBridge ?? TaskFileMentionBridge(), taskID: task.id, root: task.cwd, path: TaskHostPath.panel(path ?? "", root: task.cwd), patch: patch, split: split,
                        identity: store.connectionIdentity + ":" + task.id + ":" + task.cwd + ":" + selectionID + ":" + scope + ":" + (path ?? ""), sectionID: selection.runID.map { "turn:" + $0 } ?? selection.eventID.map { "event:" + $0 } ?? scope,
                        sectionTitle: selection.runID.map { id in "Turn " + String(task.runs?.first(where: { $0.id == id })?.executionOrder ?? ((task.runs?.firstIndex(where: { $0.id == id }) ?? 0) + 1)) } ?? (scope == "unstaged" ? "Uncommitted" : "Changes"))
                } else if loading { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
                else if truncated { empty("文件过大，请在本机编辑器中查看", symbol: "doc.text") }
                else { empty("没有文本差异", symbol: "doc.text") }
            } else if refreshing && snapshot == nil && !historical {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                empty(!historical && snapshot?.status == "not_repository" ? "这个工作区不是 Git 仓库" : "没有文件改动", symbol: "checkmark.circle")
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(FridayTheme.canvas)
            .task(id: "\(task.id)|\(selectionID)|\(scope)|\(store.connection.server)") {
                guard !historical else { return }
                snapshot = nil
                while !Task.isCancelled {
                    if store.connected { await refresh() }
                    do { try await Task.sleep(for: .seconds(5)) } catch { return }
                }
            }
            .task(id: requestKey) { await loadDiff() }
    }
    private var diffToolbar: some View {
        HStack(spacing: 10) {
            Text(verbatim: path.map { TaskExecutionPresentation.relativePath($0, cwd: task.cwd) } ?? "").font(.caption).lineLimit(1).truncationMode(.middle)
                .help(path ?? "")
            Spacer(minLength: 4)
            #if os(macOS)
            Button { split.toggle() } label: { FridaySymbolImage(systemName: split ? "rectangle.split.1x2" : "rectangle.split.2x1") }
                .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: split ? "切换为统一 Diff" : "切换为左右 Diff"))
                .help(Text(friday: split ? "统一 Diff" : "左右 Diff"))
            #endif
            Button { copyAgentText(patch) } label: { FridaySymbolImage(systemName: "doc.on.doc") }
                .buttonStyle(FridaySymbolButtonStyle()).disabled(patch.isEmpty).accessibilityLabel(Text(friday: "复制补丁"))
        }.padding(10)
    }
    private func panelNotice(_ text: String, error: Bool) -> some View {
        Text(fridayString: text).font(.caption).foregroundStyle(error ? .orange : .secondary).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading).padding(10)
    }
    private func empty(_ text: String, symbol: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.title2).foregroundStyle(.tertiary)
            Text(fridayString: text).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func refresh() async {
        refreshGeneration += 1; let generation = refreshGeneration
        refreshing = true; defer { if refreshGeneration == generation { refreshing = false } }
        do {
            let value = try await store.taskChanges(task.id, scope: scope)
            guard !Task.isCancelled, generation == refreshGeneration, value.scope == scope, !historical else { return }
            snapshot = value; error = nil; revision += 1
        } catch { if !Task.isCancelled && generation == refreshGeneration { self.error = error.localizedDescription } }
    }
    private func loadDiff() async {
        diffGeneration += 1; let generation = diffGeneration
        guard !eventHistorical, let path else { diff = nil; loading = false; diffError = nil; return }
        let key = requestKey
        if loadedDiffKey != key { diff = nil; loadedDiffKey = nil }
        loading = true; diffError = nil; defer { if generation == diffGeneration { loading = false } }
        do {
            let value = try await store.taskDiff(task.id, path: path, scope: historical ? "all" : scope, runID: selection.runID)
            guard !Task.isCancelled, generation == diffGeneration, requestKey == key else { return }
            diff = value; loadedDiffKey = key
        } catch { if !Task.isCancelled && generation == diffGeneration { diffError = error.localizedDescription } }
    }
}
