import SwiftUI

struct TaskChangeRequestCommitView: View {
    @ObservedObject var store: FridayStore
    let taskID: String; let url: String; let commit: TaskChangeRequestCommit
    @Environment(\.dismiss) private var dismiss
    @State private var response: TaskChangeRequestCommitResponse?
    @State private var selectedPath: String?
    @State private var split = false
    @State private var error: String?
    @State private var loading = false
    @State private var generation = UUID()
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(commit.messageHeadline.isEmpty ? String(localized: "未命名提交", bundle: .module) : commit.messageHeadline).font(.headline).textSelection(.enabled)
                    Text(commit.oid).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    Text(commit.authors.map { $0.name ?? $0.login }.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await load() } } label: { FridaySymbolImage(systemName: "arrow.clockwise").frame(width: 26, height: 26) }
                    .buttonStyle(FridaySymbolButtonStyle()).disabled(loading || !store.connected).help(Text(friday: "刷新"))
                Button { dismiss() } label: { FridaySymbolImage(systemName: "xmark").frame(width: 26, height: 26) }
                    .buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "关闭"))
            }.padding(14)
            Divider()
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled).padding(10) }
            if loading { Text(friday: "正在读取提交 Diff").font(.caption).foregroundStyle(.secondary).padding(10) }
            if response?.truncated == true { Text(friday: "文件较多，完整 Diff 可在平台查看").font(.caption).foregroundStyle(.secondary).padding(8) }
            HStack(spacing: 0) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        ForEach(response?.files ?? []) { file in
                            Button { selectedPath = file.path } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(file.path).lineLimit(2)
                                    Text("+\(file.additions)  −\(file.deletions)").font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                                    .background(selectedFile?.path == file.path ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
                            }.buttonStyle(FridaySymbolButtonStyle())
                        }
                    }.padding(6)
                }.frame(width: 190)
                Divider()
                VStack(spacing: 0) {
                    if let file = selectedFile {
                        HStack { Text(file.path).font(.system(.caption, design: .monospaced)).textSelection(.enabled); Spacer(); Toggle(isOn: $split) { Text(friday: "并排") }.toggleStyle(.switch).controlSize(.mini).fixedSize().fridayInteractiveCursor() }.padding(8)
                        Divider()
                        if file.unavailable { Spacer(); Text(friday: "此文件的 Diff 不可用，请在平台查看").font(.caption).foregroundStyle(.secondary).padding(); Spacer() }
                        else { TaskDiffCodeView(patch: file.patch, split: split, identity: "commit:" + commit.oid + ":" + file.path) }
                    } else {
                        Spacer(); Text(fridayString: loading ? "正在读取提交 Diff" : response == nil ? "暂未读取提交内容" : "此提交没有文件改动").font(.caption).foregroundStyle(.secondary); Spacer()
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        #if os(macOS)
        .frame(minWidth: 600, idealWidth: 960, minHeight: 520, idealHeight: 700)
        #endif
        .task(id: store.connectionIdentity + "|" + commit.oid) { await load() }
        .onDisappear { generation = UUID() }
    }
    private var selectedFile: TaskChangeRequestFiles.File? { response?.files.first(where: { $0.path == selectedPath }) ?? response?.files.first }
    @MainActor private func load() async {
        let owner = UUID(), connection = store.connectionIdentity; generation = owner; loading = true; error = nil; response = nil
        defer { if generation == owner { loading = false } }
        do {
            let value = try await store.taskChangeRequestCommit(taskID, url: url, sha: commit.oid)
            guard !Task.isCancelled, generation == owner, store.connectionIdentity == connection else { return }
            guard value.headSha == commit.oid, value.commit.oid == commit.oid else { throw TaskChangeRequestRejection(message: "平台返回的提交版本不一致") }
            response = value
            if !value.files.contains(where: { $0.path == selectedPath }) { selectedPath = value.files.first?.path }
        } catch { if !Task.isCancelled, generation == owner, store.connectionIdentity == connection { self.error = error.localizedDescription } }
    }
}
