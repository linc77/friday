import SwiftUI

struct TaskDiffStat: View {
    let additions: Int?; let deletions: Int?
    var aligned = false
    var body: some View {
        HStack(spacing: aligned ? 10 : 6) {
            if let additions, aligned || additions > 0 {
                Text(verbatim: "+\(additions)").foregroundStyle(.green)
                    .frame(minWidth: aligned ? 34 : nil, alignment: .trailing)
            }
            if let deletions, aligned || deletions > 0 {
                Text(verbatim: "−\(deletions)").foregroundStyle(.red)
                    .frame(minWidth: aligned ? 34 : nil, alignment: .trailing)
            }
        }.font(.system(.caption, design: .monospaced)).monospacedDigit().fixedSize()
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
    private var directories: Set<String> { TaskFileTree.directories(paths: paths, cwd: task.cwd, compact: true) }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(friday: "\(changes.count) 个文件改动").font(.caption.weight(.medium))
                TaskDiffStat(additions: changes.reduce(0) { $0 + $1.additions }, deletions: changes.reduce(0) { $0 + $1.deletions })
                Spacer(minLength: 4)
                if !directories.isEmpty {
                    Button { collapsed = collapsed.isDisjoint(with: directories) ? directories : [] } label: {
                        FridaySymbolImage(systemName: collapsed.isDisjoint(with: directories) ? "chevron.up.chevron.down" : "chevron.down")
                    }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: collapsed.isDisjoint(with: directories) ? "收起所有文件夹" : "展开所有文件夹"))
                }
                Button { open(changes.first?.path) } label: { FridaySymbolLabel(friday: "打开 Diff", systemImage: "doc.text.magnifyingglass") }
                    .buttonStyle(FridaySymbolButtonStyle()).font(.caption)
            }.padding(.horizontal, 12).padding(.vertical, 10)
            if event.status != "completed" {
                Text(friday: event.status == "running" ? "正在修改文件" : "这些改动未确认应用成功")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.bottom, 8)
            }
            TaskFileTreeView(paths: paths, cwd: task.cwd, collapsed: $collapsed, selected: nil, canOpenLocalFiles: canOpenLocalFiles, open: { open($0) }, compact: true, directoryStats: TaskFileTree.directoryStats(changes.map { ($0.path, $0.additions, $0.deletions) }, cwd: task.cwd)) { path in
                if let file = changes.first(where: { $0.path == path }) { TaskDiffStat(additions: file.additions, deletions: file.deletions, aligned: true) }
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
    private var directories: Set<String> { TaskFileTree.directories(paths: paths, cwd: run.cwd, compact: true) }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                if run.diffError != nil {
                    Text(friday: "整轮文件改动暂不可用").font(.caption.weight(.medium))
                } else {
                    Text(friday: "\(changes.count) 个文件改动").font(.caption.weight(.medium))
                }
                if !changes.isEmpty {
                    TaskDiffStat(additions: changes.reduce(0) { $0 + ($1.additions ?? 0) }, deletions: changes.reduce(0) { $0 + ($1.deletions ?? 0) })
                }
                Spacer(minLength: 4)
                if !directories.isEmpty {
                    Button { collapsed = collapsed.isDisjoint(with: directories) ? directories : [] } label: { FridaySymbolImage(systemName: collapsed.isDisjoint(with: directories) ? "chevron.up.chevron.down" : "chevron.down") }
                        .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: collapsed.isDisjoint(with: directories) ? "收起所有文件夹" : "展开所有文件夹"))
                }
                if !paths.isEmpty {
                    Button { open(paths.first) } label: { FridaySymbolLabel(friday: "打开 Diff", systemImage: "doc.text.magnifyingglass") }
                        .buttonStyle(FridaySymbolButtonStyle()).font(.caption)
                }
            }.padding(.horizontal, 12).padding(.vertical, 10)
            if let error = run.diffError {
                Text(verbatim: error).font(.caption).foregroundStyle(.secondary).textSelection(.enabled).padding(.horizontal, 12).padding(.bottom, 10)
            }
            if !paths.isEmpty {
                TaskFileTreeView(paths: paths, cwd: run.cwd, collapsed: $collapsed, selected: nil, canOpenLocalFiles: canOpenLocalFiles, open: { open($0) }, compact: true, directoryStats: TaskFileTree.directoryStats(changes.map { ($0.path, $0.additions, $0.deletions) }, cwd: run.cwd)) { path in
                    if let file = changes.first(where: { $0.path == path }) {
                        if file.binary { Text(friday: "二进制").font(.caption).foregroundStyle(.secondary) }
                        else { TaskDiffStat(additions: file.additions, deletions: file.deletions, aligned: true) }
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
    var compact = false
    var directoryStats: [String: TaskFileTree.Stat] = [:]
    @ViewBuilder let accessory: (String) -> Accessory
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 0 : 1) {
            ForEach(TaskFileTree.rows(paths: paths, cwd: cwd, collapsed: collapsed, compact: compact)) { row in
                Button {
                    if row.directory { if collapsed.contains(row.path) { collapsed.remove(row.path) } else { collapsed.insert(row.path) } }
                    else if let path = row.originalPath { open(path) }
                } label: {
                    HStack(spacing: compact ? 8 : 7) {
                        if row.directory {
                            FridaySymbolImage(systemName: collapsed.contains(row.path) ? "chevron.right" : "chevron.down").font(.system(size: 9)).frame(width: 10)
                        } else if !compact || paths.contains(where: { TaskExecutionPresentation.relativePath($0, cwd: cwd).contains("/") }) { Color.clear.frame(width: 10, height: 1) }
                        FridaySymbolImage(systemName: row.directory ? "folder" : "doc.text").foregroundStyle(.secondary).frame(width: 14)
                        Text(verbatim: row.name).lineLimit(1).truncationMode(.middle)
                            .foregroundStyle(compact && row.directory ? Color.secondary : Color.primary)
                        Spacer(minLength: 4)
                        if let path = row.originalPath { accessory(path) }
                        else if let stat = directoryStats[row.path], stat.additions > 0 || stat.deletions > 0 {
                            TaskDiffStat(additions: stat.additions, deletions: stat.deletions, aligned: true)
                        }
                    }.font(.system(.caption, design: compact ? .monospaced : .default))
                        .padding(.leading, (compact ? 8 : 5) + CGFloat(row.depth) * 14).padding(.trailing, 7).padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        .background(selected != nil && row.originalPath == selected ? FridayTheme.accent.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 5))
                }.buttonStyle(FridaySymbolButtonStyle())
                    .help(row.path)
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
                    Text(verbatim: step.step).foregroundStyle(step.status == "pending" ? .secondary : .primary).textSelection(.enabled)
                }.font(.callout).accessibilityElement(children: .combine)
                    .accessibilityValue(Text(fridayString: step.status == "completed" ? "已完成" : step.status == "inProgress" ? "进行中" : "待处理"))
            }
        }
    }
}
