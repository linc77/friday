import SwiftUI

struct ProjectCloneControl: View {
    @ObservedObject var store: FridayStore
    let project: Project
    @State private var busy = false
    @State private var requestID = UUID().uuidString
    @State private var operation: UUID?
    @State private var error: String?
    private func stage(_ value: String) -> String {
        switch value { case "counting": "统计对象"; case "receiving": "接收对象"; case "resolving": "解析差异"; case "checkout": "检出文件"; default: "连接仓库" }
    }
    var body: some View {
        if let current = store.projects.first(where: { $0.id == project.id }), let clone = current.clone, clone.blocksTasks {
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Text(friday: clone.phase == "running" ? "正在克隆仓库" : clone.phase == "cancelled" ? "克隆已取消" : "仓库克隆未完成").font(.callout.weight(.medium))
                    Spacer()
                    Button(friday: clone.phase == "running" ? "取消克隆" : "重试克隆") { perform(clone.phase == "running", project: current) }
                        .buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected)
                }
                if clone.phase == "running" {
                    HStack {
                        Text(fridayString: stage(clone.stage)).font(.caption).foregroundStyle(.secondary)
                        if let percent = clone.percent { Text(verbatim: "\(Int(percent))%").font(.caption.monospacedDigit()) }
                        if let detail = clone.detail { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary) }
                    }
                    if let percent = clone.percent { ProgressView(value: percent, total: 100) }
                }
                if let error = error ?? clone.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
                if clone.phase != "running" { Text(friday: "重试会清理本次未完成的克隆内容；已有项目会继续保留。").font(.caption).foregroundStyle(.secondary) }
            }.padding(14).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
                .onChange(of: store.connectionIdentity) { _, _ in operation = nil; busy = false; error = nil; requestID = UUID().uuidString }
                .onChange(of: clone.operationId) { _, _ in requestID = UUID().uuidString }
        }
    }
    private func perform(_ cancel: Bool, project: Project) {
        guard !busy else { return }; busy = true; error = nil
        let identity = store.connectionIdentity, token = UUID(); operation = token
        Task {
            defer { if operation == token { busy = false } }
            guard identity == store.connectionIdentity, operation == token else { return }
            do { if cancel { try await store.cancelProjectClone(project) } else { try await store.retryProjectClone(project, requestID: requestID) } }
            catch { if identity == store.connectionIdentity, operation == token { self.error = error.localizedDescription } }
        }
    }
}

struct ProjectPublicationNotices: View {
    @ObservedObject var store: FridayStore
    @Environment(\.openURL) private var openURL
    @State private var dismissed: Set<String> = []
    var body: some View {
        TimelineView(.periodic(from: .now, by: 2)) { clock in
            let operations = store.projectRepositoryOperations.filter { value in
                store.snapshotIdentity == store.connectionIdentity && value.kind == "publish" && !dismissed.contains(value.id) && (value.active || clock.date.timeIntervalSince(CodexTranscript.date(value.updatedAt) ?? .distantPast) < 30)
            }.suffix(3)
            VStack(alignment: .trailing, spacing: 8) {
                ForEach(Array(operations)) { operation in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(friday: operation.active ? "正在发布私有仓库" : operation.status == "completed" ? "私有仓库已创建" : "仓库发布未完成").font(.callout.weight(.medium))
                            Spacer(minLength: 12)
                            Button { dismissed.insert(operation.id) } label: { FridaySymbolImage(systemName: "xmark") }
                                .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "关闭"))
                        }
                        if let publication = operation.publication {
                            Text(verbatim: publication.nameWithOwner).font(.caption).textSelection(.enabled)
                            Button(friday: "打开仓库", systemImage: "arrow.up.right.square") {
                                if let url = URL(string: publication.url), ["http", "https"].contains(url.scheme ?? ""), url.user == nil, url.password == nil { openURL(url) }
                            }.buttonStyle(FridayButtonStyle(compact: true))
                        }
                        if let error = operation.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).lineLimit(6).textSelection(.enabled) }
                    }.padding(14).frame(maxWidth: 360, alignment: .leading).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }.onChange(of: store.connectionIdentity) { _, _ in dismissed = [] }
    }
}
