import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#endif

struct TaskDiffStat: View {
    let additions: Int?; let deletions: Int?
    var body: some View {
        HStack(spacing: 6) {
            if let additions, additions > 0 { Text(verbatim: "+\(additions)").foregroundStyle(.green) }
            if let deletions, deletions > 0 { Text(verbatim: "−\(deletions)").foregroundStyle(.red) }
        }.font(.system(.caption, design: .monospaced)).monospacedDigit()
            .accessibilityElement(children: .combine)
    }
}

struct TaskChangedFilesCard: View {
    let task: WorkItem; let event: TaskEvent
    let canOpenLocalFiles: Bool
    let open: (String?) -> Void
    @State private var collapsed: Set<String> = []
    private var changes: [TaskFileChange] { event.changes ?? [] }
    private var paths: [String] { changes.map(\.path) }
    private var directories: Set<String> { TaskFileTree.directories(paths: paths, cwd: task.cwd) }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(friday: "\(changes.count) 个文件改动").font(.caption.weight(.medium))
                TaskDiffStat(additions: changes.reduce(0) { $0 + $1.additions }, deletions: changes.reduce(0) { $0 + $1.deletions })
                Spacer(minLength: 4)
                if !directories.isEmpty {
                    Button { collapsed = collapsed.isEmpty ? directories : [] } label: {
                        FridaySymbolImage(systemName: collapsed.isEmpty ? "chevron.up.chevron.down" : "chevron.down")
                    }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: collapsed.isEmpty ? "收起所有文件夹" : "展开所有文件夹"))
                }
                Button { open(changes.first?.path) } label: { FridaySymbolLabel(friday: "打开 Diff", systemImage: "doc.text.magnifyingglass") }
                    .buttonStyle(FridaySymbolButtonStyle()).font(.caption)
            }.padding(12)
            if event.status != "completed" {
                Text(friday: event.status == "running" ? "正在修改文件" : "这些改动未确认应用成功")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.bottom, 8)
            }
            TaskFileTreeView(paths: paths, cwd: task.cwd, collapsed: $collapsed, selected: nil, canOpenLocalFiles: canOpenLocalFiles, open: { open($0) }) { path in
                if let file = changes.first(where: { $0.path == path }) { TaskDiffStat(additions: file.additions, deletions: file.deletions) }
            }.padding(.horizontal, 6).padding(.bottom, 8)
        }.background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct TaskRunChangesCard: View {
    let run: TaskRun
    let canOpenLocalFiles: Bool
    let open: (String?) -> Void
    @State private var collapsed: Set<String> = []
    private var changes: [TaskRunFile] { run.changes ?? [] }
    private var paths: [String] { changes.map(\.path) }
    private var directories: Set<String> { TaskFileTree.directories(paths: paths, cwd: run.cwd) }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(friday: run.diffError == nil ? "整轮文件改动" : "整轮文件改动暂不可用").font(.caption.weight(.medium))
                if !changes.isEmpty {
                    Text(verbatim: "\(changes.count)").font(.caption).foregroundStyle(.secondary)
                    TaskDiffStat(additions: changes.reduce(0) { $0 + ($1.additions ?? 0) }, deletions: changes.reduce(0) { $0 + ($1.deletions ?? 0) })
                }
                Spacer(minLength: 4)
                if !directories.isEmpty {
                    Button { collapsed = collapsed.isEmpty ? directories : [] } label: { FridaySymbolImage(systemName: collapsed.isEmpty ? "chevron.up.chevron.down" : "chevron.down") }
                        .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: collapsed.isEmpty ? "收起所有文件夹" : "展开所有文件夹"))
                }
                if !paths.isEmpty {
                    Button { open(paths.first) } label: { FridaySymbolLabel(friday: "打开 Diff", systemImage: "doc.text.magnifyingglass") }
                        .buttonStyle(FridaySymbolButtonStyle()).font(.caption)
                }
            }.padding(12)
            if let error = run.diffError {
                Text(verbatim: error).font(.caption).foregroundStyle(.secondary).textSelection(.enabled).padding(.horizontal, 12).padding(.bottom, 10)
            }
            if !paths.isEmpty {
                TaskFileTreeView(paths: paths, cwd: run.cwd, collapsed: $collapsed, selected: nil, canOpenLocalFiles: canOpenLocalFiles, open: { open($0) }) { path in
                    if let file = changes.first(where: { $0.path == path }) {
                        if file.binary { Text(friday: "二进制").font(.caption).foregroundStyle(.secondary) }
                        else { TaskDiffStat(additions: file.additions, deletions: file.deletions) }
                    }
                }.padding(.horizontal, 6).padding(.bottom, 8)
            }
        }.background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct TaskFileTreeView<Accessory: View>: View {
    let paths: [String]; let cwd: String
    @Binding var collapsed: Set<String>
    let selected: String?
    let canOpenLocalFiles: Bool
    let open: (String) -> Void
    @ViewBuilder let accessory: (String) -> Accessory
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(TaskFileTree.rows(paths: paths, cwd: cwd, collapsed: collapsed)) { row in
                Button {
                    if row.directory { if collapsed.contains(row.path) { collapsed.remove(row.path) } else { collapsed.insert(row.path) } }
                    else if let path = row.originalPath { open(path) }
                } label: {
                    HStack(spacing: 7) {
                        if row.directory {
                            FridaySymbolImage(systemName: collapsed.contains(row.path) ? "chevron.right" : "chevron.down").font(.system(size: 9)).frame(width: 10)
                        } else { Color.clear.frame(width: 10, height: 1) }
                        FridaySymbolImage(systemName: row.directory ? "folder" : "doc.text").foregroundStyle(.secondary).frame(width: 14)
                        Text(verbatim: row.name).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 4)
                        if let path = row.originalPath { accessory(path) }
                    }.font(.caption).padding(.leading, 5 + CGFloat(row.depth) * 14).padding(.trailing, 7).padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        .background(selected != nil && row.originalPath == selected ? FridayTheme.accent.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 5))
                }.buttonStyle(FridaySymbolButtonStyle())
                    .accessibilityLabel(Text(verbatim: row.path))
                    .accessibilityValue(Text(fridayString: row.directory ? (collapsed.contains(row.path) ? "已收起" : "已展开") : ""))
                    .contextMenu {
                        if let path = row.originalPath {
                            Button(friday: "复制文件路径", systemImage: "doc.on.doc") { copyAgentText(path) }
                            Button(friday: "复制相对路径", systemImage: "doc.on.doc") { copyAgentText(TaskExecutionPresentation.relativePath(path, cwd: cwd)) }
                            #if os(macOS)
                            if canOpenLocalFiles, let url = localFile(path) {
                                Button(friday: "打开文件", systemImage: "arrow.up.forward.square") { NSWorkspace.shared.open(url) }
                                Button(friday: "在 Finder 中显示", systemImage: "folder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                            }
                            #endif
                        }
                    }
            }
        }
    }
    #if os(macOS)
    private func localFile(_ path: String) -> URL? {
        let root = URL(fileURLWithPath: cwd).resolvingSymlinksInPath().standardizedFileURL
        let value = (path.hasPrefix("/") ? URL(fileURLWithPath: path) : root.appendingPathComponent(path)).resolvingSymlinksInPath().standardizedFileURL
        return value.path.hasPrefix(root.path + "/") && FileManager.default.fileExists(atPath: value.path) ? value : nil
    }
    #endif
}

struct TaskPlanProgress: View {
    let steps: [TaskPlanStep]; let explanation: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let explanation, !explanation.isEmpty { Text(verbatim: explanation).font(.callout).foregroundStyle(.secondary).textSelection(.enabled) }
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                HStack(alignment: .top, spacing: 9) {
                    FridaySymbolImage(systemName: step.status == "completed" ? "checkmark.circle.fill" : step.status == "inProgress" ? "circle.dashed" : "circle")
                        .foregroundStyle(step.status == "completed" ? .green : step.status == "inProgress" ? FridayTheme.accent : .secondary)
                        .fridaySymbolFeedback(value: step.status)
                    Text(verbatim: step.step).foregroundStyle(step.status == "pending" ? .secondary : .primary).textSelection(.enabled)
                }.font(.callout).accessibilityElement(children: .combine)
                    .accessibilityValue(Text(fridayString: step.status == "completed" ? "已完成" : step.status == "inProgress" ? "进行中" : "待处理"))
            }
        }
    }
}

private struct TaskPlanDocument: FileDocument {
    static let readableContentTypes: [UTType] = [UTType(filenameExtension: "md", conformingTo: .plainText) ?? .plainText]
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws { text = String(data: configuration.file.regularFileContents ?? Data(), encoding: .utf8) ?? "" }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: Data(text.utf8)) }
}

struct TaskProposedPlanCard: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem; let event: TaskEvent; let canOpenLocalFiles: Bool
    @State private var expanded = false
    @State private var exporting = false
    @State private var saving = false
    @State private var saveSheet = false
    @State private var savePath = ""
    @State private var error: String?
    @State private var savedPath: String?
    private var markdown: String { TaskExecutionPresentation.planMarkdown(event.text) }
    private var collapsible: Bool { markdown.utf16.count > 900 || markdown.components(separatedBy: "\n").count > 20 }
    private var displayed: String { collapsible && !expanded ? TaskExecutionPresentation.planPreview(markdown) : TaskExecutionPresentation.displayedPlan(markdown) }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Text(verbatim: "Plan").font(.caption.weight(.medium)).padding(.horizontal, 8).padding(.vertical, 3).background(.primary.opacity(0.07), in: Capsule())
                Group {
                    if let title = TaskExecutionPresentation.planTitle(markdown) { Text(verbatim: title) }
                    else { Text(friday: "待确认方案") }
                }.font(.callout.weight(.medium)).lineLimit(1)
                Spacer(minLength: 4)
                Menu {
                    Button(friday: "复制方案", systemImage: "doc.on.doc") { copyAgentText(markdown + "\n") }
                    Button(friday: "导出 Markdown", systemImage: "square.and.arrow.down") { exporting = true }
                    Button(friday: "保存到工作区", systemImage: "folder") {
                        if savePath.isEmpty { savePath = TaskExecutionPresentation.planFilename(markdown) }
                        error = nil; saveSheet = true
                    }.disabled(event.status != "completed" || !store.connected)
                } label: { FridaySymbolImage(systemName: "ellipsis") }
                    .menuStyle(.borderlessButton).fixedSize().fridayInteractiveCursor()
                    .accessibilityLabel(Text(friday: "方案操作"))
            }
            AgentMarkdown(text: displayed, canOpenLocalFiles: canOpenLocalFiles, workspacePath: task.cwd, isStreaming: event.status == "running" || collapsible && !expanded)
            if collapsible {
                Button { expanded.toggle() } label: {
                    FridaySymbolLabel(friday: expanded ? "收起方案" : "展开完整方案", systemImage: expanded ? "chevron.up" : "chevron.down")
                }.buttonStyle(FridaySymbolButtonStyle()).font(.caption).foregroundStyle(.secondary)
                    .accessibilityValue(Text(friday: expanded ? "已展开" : "已收起"))
            }
            if let savedPath { Text(friday: "已保存到 \(savedPath)").font(.caption).foregroundStyle(.secondary) }
            if let error, !saveSheet { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
        }.padding(18).background(.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.primary.opacity(0.12), lineWidth: 1))
            .fileExporter(isPresented: $exporting, document: TaskPlanDocument(text: markdown + "\n"), contentType: TaskPlanDocument.readableContentTypes[0], defaultFilename: TaskExecutionPresentation.planFilename(markdown)) { result in
                if case .failure(let failure) = result { error = failure.localizedDescription }
            }
            .sheet(isPresented: $saveSheet) { saveForm }
    }
    private var saveForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(friday: "保存到工作区").font(.headline)
            Text(verbatim: task.cwd).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            TextField(friday: "相对文件路径", text: $savePath).textFieldStyle(.roundedBorder).disabled(saving)
                .onSubmit { save() }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
            HStack {
                Spacer()
                Button(friday: "取消") { saveSheet = false }.buttonStyle(FridayButtonStyle(compact: true)).disabled(saving).keyboardShortcut(.cancelAction)
                Button(friday: "保存") { save() }.buttonStyle(FridayButtonStyle(prominent: true, compact: true))
                    .disabled(saving || savePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(minWidth: 320, idealWidth: 440)
            .interactiveDismissDisabled(saving)
    }
    private func save() {
        guard !saving, !savePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        saving = true; error = nil
        Task {
            defer { saving = false }
            do { try await store.saveTaskPlan(task.id, eventID: event.id, path: savePath); savedPath = savePath; saveSheet = false }
            catch { self.error = error.localizedDescription }
        }
    }
}
