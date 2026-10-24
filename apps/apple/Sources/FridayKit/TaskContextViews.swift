import SwiftUI

struct TaskContextPreview: View {
    @ObservedObject var store: FridayStore
    let reference: TaskContextReference
    let scope: TaskContextScope
    @State private var snapshot: TaskContextSnapshot?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                FridaySymbolImage(systemName: reference.symbol)
                Text(verbatim: reference.label).font(.callout.weight(.medium)).textSelection(.enabled)
                Spacer(minLength: 0)
                Button { if let snapshot { copyAgentText(snapshot.copiedContents) } } label: { FridaySymbolImage(systemName: "doc.on.doc") }
                    .buttonStyle(FridaySymbolButtonStyle()).disabled(snapshot == nil).accessibilityLabel(Text(friday: "复制引用内容"))
            }
            if let snapshot {
                Text(verbatim: snapshot.cwd).font(.caption).foregroundStyle(.secondary).lineLimit(2).textSelection(.enabled)
                if reference.kind == "attachment" {
                    TaskAttachmentDownload(store: store, reference: reference, scope: scope)
                } else if let annotation=snapshot.browserAnnotation {
                    TaskBrowserAnnotationPreview(store:store,annotation:annotation)
                } else if let review = snapshot.fileReview {
                    Text(verbatim: review.text).font(.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    TaskSourceFileView(source: review.source, language: review.fenceLanguage, identity: reference.id, line: nil, reveal: 0, wrapping: true).frame(minHeight: 100)
                } else { ScrollView([.vertical, .horizontal]) {
                    Text(verbatim: snapshot.text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                }.background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6)) }
                if reference.truncated == true { Text(friday: "引用内容已截取，未包含全部源内容。").font(.caption).foregroundStyle(.orange) }
                if let date = CodexTranscript.date(reference.capturedAt) { HStack { Text(friday: "捕获于"); Text(date, format: .dateTime.month().day().hour().minute().second()) }.font(.caption).foregroundStyle(.secondary) }
            } else if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            else { ProgressView().frame(maxWidth: .infinity, minHeight: 80) }
        }.padding(16).frame(minWidth: 300, idealWidth: 480, maxWidth: 640, minHeight: 150, idealHeight: 320, maxHeight: 520)
        .task(id: store.connection.server + "|" + reference.id) {
            do { snapshot = try await store.taskContext(reference, scope: scope) } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}

struct TaskContextSuggestionList: View {
    let entries: [TaskFileEntry]
    let selected: Int
    let loading: Bool
    let choose: (TaskFileEntry) -> Void
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 2) {
                    if loading { Text(friday: "正在查找…").font(.caption).padding(12) }
                    if !loading && entries.isEmpty { Text(friday: "未找到匹配项").font(.caption).foregroundStyle(.secondary).padding(14) }
                    ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                        Button { choose(entry) } label: {
                            HStack(spacing: 8) {
                                FridaySymbolImage(systemName: entry.symbol).font(.system(size: 13)).frame(width: 18)
                                Text(verbatim: ["skill", "builtin", "provider-command"].contains(entry.kind) ? entry.name : entry.path + (entry.kind == "directory" ? "/" : "")).font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
                                if let detail = entry.detail {
                                    if entry.kind == "builtin" || entry.path == "command:usage-limits" { Text(fridayString: detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                                    else { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                                }
                                Spacer(minLength: 0)
                                if index == selected { FridaySymbolImage(systemName: "return").font(.system(size: 10)).foregroundStyle(.secondary) }
                            }.padding(.horizontal, 10).padding(.vertical, 7).contentShape(Rectangle())
                                .background(index == selected ? FridayTheme.accent.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 5))
                        }.buttonStyle(FridaySymbolButtonStyle()).id(entry.id)
                    }
                }.padding(5)
            }.onChange(of: selected) { _, index in if entries.indices.contains(index) { proxy.scrollTo(entries[index].id, anchor: .center) } }
        }.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 9)).overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(.primary.opacity(0.12), lineWidth: 0.5))
    }
}

struct TaskFileReferencePicker: View {
    @ObservedObject var store: FridayStore
    let scope: TaskContextScope
    let add: (TaskContextReference) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var directory = ""
    @State private var query = ""
    @State private var entries: [TaskFileEntry] = []
    @State private var selected: TaskFileEntry?
    @State private var preview: TaskFilePreview?
    @State private var error: String?
    @State private var loading = false
    @State private var capturing = false
    @State private var start = 1
    @State private var end = 1
    @State private var previewRevision = 0
    @FocusState private var searchFocused: Bool
    private var queryKey: String { store.connection.server + "|" + scope.identity + "|" + directory + "|" + query }
    private var minimumWidth: CGFloat {
        #if os(macOS)
        540
        #else
        0
        #endif
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(friday: "引用 Workspace 内容").font(.headline)
                Spacer()
                Button(friday: "取消") { dismiss() }.keyboardShortcut(.cancelAction)
            }.padding(16)
            HStack {
                if !directory.isEmpty { Button { directory = directory.split(separator: "/").dropLast().joined(separator: "/"); selected = nil; preview = nil } label: { FridaySymbolImage(systemName: "arrow.up") }.buttonStyle(FridaySymbolButtonStyle()) }
                TextField(friday: "搜索文件或目录", text: $query).textFieldStyle(.roundedBorder).focused($searchFocused)
            }.padding(.horizontal, 16).padding(.bottom, 12)
            Divider()
            fileContent
            Divider()
            HStack(spacing: 12) {
                if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).lineLimit(2) }
                Spacer(minLength: 0)
                if capturing { ProgressView().controlSize(.small) }
                Button(friday: "引用此目录") { capture(kind: "directory") }.disabled(capturing)
                Button(friday: "引用文件") { capture(kind: "file") }.disabled(capturing || preview == nil).keyboardShortcut(.defaultAction)
            }.padding(14)
        }.frame(minWidth: minimumWidth, idealWidth: 760, maxWidth: .infinity, minHeight: 360, idealHeight: 520)
        .task(id: queryKey) {
            loading = true; error = nil
            do {
                try await Task.sleep(for: .milliseconds(120))
                let value = query.isEmpty ? "path=" + encode(directory) : "search=" + encode(query)
                let result = try await store.connection.decode(TaskFileListing.self, "/api/task-files?\(scope.query)&\(value)")
                if !Task.isCancelled { entries = result.entries; loading = false }
            } catch { if !Task.isCancelled { self.error = error.localizedDescription; loading = false } }
        }
        .task(id: (selected?.id ?? "") + "|" + String(previewRevision)) {
            preview = nil
            guard let selected, selected.kind == "file" else { return }
            do {
                let value = try await store.connection.decode(TaskFilePreview.self, "/api/task-files/preview?\(scope.query)&path=\(encode(selected.path))")
                if !Task.isCancelled { preview = value; start = value.lineStart; end = min(value.lineEnd, 5000); error = nil }
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
        .onAppear { searchFocused = true }
    }
    @ViewBuilder private var fileContent: some View {
        #if os(iOS)
        if sizeClass == .compact {
            VStack(spacing: 0) { fileList.frame(height: 145); Divider(); filePreview }
        } else {
            HStack(spacing: 0) { fileList.frame(minWidth: 170, idealWidth: 220, maxWidth: 270); Divider(); filePreview }
        }
        #else
        HStack(spacing: 0) { fileList.frame(minWidth: 170, idealWidth: 220, maxWidth: 270); Divider(); filePreview }
        #endif
    }
    private var fileList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(entries) { entry in
                    Button {
                        if entry.kind == "directory" { directory = entry.path; query = ""; selected = entry; preview = nil }
                        else { selected = entry }
                    } label: {
                        HStack(spacing: 7) { FridaySymbolImage(systemName: entry.symbol); Text(verbatim: entry.path).lineLimit(1).truncationMode(.middle); Spacer(minLength: 0) }
                            .font(.caption).padding(9).contentShape(Rectangle()).background(selected?.id == entry.id ? FridayTheme.accent.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 5))
                    }.buttonStyle(FridaySymbolButtonStyle())
                }
                if loading { ProgressView().frame(maxWidth: .infinity).padding() }
            }.padding(8)
        }
    }
    private var filePreview: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let preview {
                HStack {
                    Text(verbatim: preview.path).font(.caption.weight(.medium)).textSelection(.enabled)
                    Spacer(minLength: 0)
                    Button { previewRevision += 1 } label: { FridaySymbolImage(systemName: "arrow.clockwise") }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "刷新引用预览"))
                }
                ScrollView([.vertical, .horizontal]) { Text(verbatim: preview.text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: .infinity)
                HStack(spacing: 8) {
                    Text(friday: "行范围").font(.caption)
                    TextField("", value: $start, format: .number).frame(width: 55)
                    Text("–")
                    TextField("", value: $end, format: .number).frame(width: 55)
                    Spacer(minLength: 0)
                    Button(friday: "引用代码") { capture(kind: "code") }.disabled(capturing || start < 1 || end < start || end > preview.lineEnd)
                }.textFieldStyle(.roundedBorder)
                if preview.truncated { Text(friday: "这是截取的引用，未包含全部文件内容。").font(.caption).foregroundStyle(.orange) }
            } else { Text(friday: "选择文件以预览，或引用当前目录。").font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity) }
        }.padding(12).frame(maxWidth: .infinity)
    }
    private func encode(_ text: String) -> String { text.addingPercentEncoding(withAllowedCharacters: .urlQueryValueAllowed) ?? "" }
    private func capture(kind: String) {
        guard !capturing else { return }; capturing = true; error = nil
        var input: [String: Any] = ["kind": kind, "path": kind == "directory" ? directory : preview?.path ?? ""]
        if kind != "directory", let preview { input["expectedVersion"] = preview.version }
        if kind == "code" { input["lineStart"] = start; input["lineEnd"] = end }
        Task { @MainActor in
            defer { capturing = false }
            do { let reference = try await store.captureTaskContext(scope: scope, input: input); add(reference); dismiss() }
            catch { self.error = error.localizedDescription; if error.localizedDescription.contains("文件已改变") { previewRevision += 1 } }
        }
    }
}

extension CharacterSet {
    static let urlQueryValueAllowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+=?#"))
}
