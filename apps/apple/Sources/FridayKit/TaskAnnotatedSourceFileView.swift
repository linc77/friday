import SwiftUI

struct TaskAnnotatedSourceFileView: View {
    let source: String; let language: String; let identity: String; let line: Int?; let reveal: Int; let wrapping: Bool
    let editable: Bool; let path: String; let workspaceRoot: String; let workspaceVersion: String
    let change: (String) -> Void
    @ObservedObject var bridge: TaskFileMentionBridge
    @State private var state: TaskFileAnnotationState
    @State private var error: String?
    init(source: String, language: String, identity: String, line: Int?, reveal: Int, wrapping: Bool, editable: Bool, path: String, workspaceRoot: String, workspaceVersion: String, bridge: TaskFileMentionBridge, change: @escaping (String) -> Void) {
        self.source = source; self.language = language; self.identity = identity; self.line = line; self.reveal = reveal; self.wrapping = wrapping; self.editable = editable; self.path = path; self.workspaceRoot = workspaceRoot; self.workspaceVersion = workspaceVersion; self.change = change
        _state = State(initialValue: TaskFileAnnotationState(source: source))
        self.bridge = bridge
    }
    var body: some View {
        VStack(spacing: 0) {
            TaskSourceFileView(source: source, language: language, identity: identity, line: line, reveal: reveal, wrapping: wrapping, editable: editable, change: change,
                edited: { contents, undo, redo, edit in
                    state.change(contents, undo: undo, redo: redo, edit: edit); refreshComments(); change(contents)
                }, annotations: state.annotations, canComment: editable && bridge.context?.reviewEnabled == true && !state.annotations.contains { $0.text == nil },
                beginComment: { range in state.begin(range) }, submitComment: submit, removeComment: remove)
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).padding(8) }
        }
        .onChange(of: source) { _, contents in if contents != state.source { state.change(contents, external: true) } }
    }
    private func draft(_ annotation: TaskFileLineAnnotation, context: TaskFileMentionContext) -> TaskFileReviewDraft? {
        guard let text = annotation.text, let target = state.references[annotation.id]?.target ?? context.reviewTarget else { return nil }
        let lines = state.source.components(separatedBy: "\n"), range = annotation.range
        let contents = lines.dropFirst(min(lines.count, range.start - 1)).prefix(range.end - range.start + 1).joined(separator: "\n")
        return TaskFileReviewDraft(commentID: annotation.id.uuidString, scope: context.scope, target: target, workspaceRoot: workspaceRoot, workspaceVersion: workspaceVersion, path: path, range: range,
            comment: TaskFileReviewDraft.clipped(text.trimmingCharacters(in: .whitespacesAndNewlines), length: 16_000), contents: TaskFileReviewDraft.clipped(contents, length: 32_000))
    }
    @discardableResult private func publish(_ index: Int) -> Bool {
        guard let context = bridge.context, context.reviewEnabled,
              let draft = draft(state.annotations[index], context: context), context.review?(.upsert(draft, replacing: state.references[state.annotations[index].id]?.referenceID)) == true else {
            error = "输入框尚未准备好接收批注"; return false
        }
        state.references[state.annotations[index].id] = TaskFileReviewBinding(referenceID: draft.reference.id, target: draft.target); error = nil; return true
    }
    private func refreshComments() { for index in state.annotations.indices where state.annotations[index].text != nil { _ = publish(index) } }
    private func submit(_ id: UUID, _ text: String) {
        guard let index = state.annotations.firstIndex(where: { $0.id == id }), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        state.annotations[index].text = text
        if !publish(index) { state.annotations[index].text = nil }
    }
    private func remove(_ id: UUID) {
        guard let value = state.annotations.first(where: { $0.id == id }) else { return }
        if let binding = state.references[value.id] { _ = bridge.context?.review?(.remove(binding.referenceID, target: binding.target)) }
        state.references.removeValue(forKey: value.id)
        state.annotations.removeAll { $0.id == id }; error = nil
    }
}

struct TaskFileCommentCard: View {
    let annotation: TaskFileLineAnnotation
    var rangeLabel: String? = nil
    let submit: (UUID, String) -> Void
    let remove: (UUID) -> Void
    @State private var text = ""
    @FocusState private var focused: Bool
    var body: some View {
        Group {
            if let value = annotation.text {
                HStack(alignment: .top, spacing: 9) {
                    FridaySymbolImage(systemName: "text.bubble").foregroundStyle(FridayTheme.accent)
                    Text(verbatim: value).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    Button { remove(annotation.id) } label: { FridaySymbolImage(systemName: "trash").font(.caption) }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "删除批注"))
                }.padding(10).background(FridayTheme.accent.opacity(0.045)).overlay(alignment: .leading) { Rectangle().fill(FridayTheme.accent.opacity(0.55)).frame(width: 2) }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ZStack(alignment: .topLeading) {
                        if text.isEmpty { Text(friday: "添加批注…").font(.callout).foregroundStyle(.tertiary).padding(5).allowsHitTesting(false) }
                        TextEditor(text: $text).font(.callout).scrollContentBackground(.hidden).focused($focused)
                            .frame(minHeight: 64, maxHeight: 110).accessibilityLabel(Text(verbatim: rangeLabel ?? annotation.range.label))
                            .onKeyPress(.escape) { remove(annotation.id); return .handled }
                            .onKeyPress(keys: [.return], phases: .down) { event in
                                guard event.modifiers.contains(.command) || event.modifiers.contains(.control) else { return .ignored }
                                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { submit(annotation.id, text) }; return .handled
                            }
                    }.background(.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 5))
                    HStack(spacing: 6) {
                        Text(friday: "⌘ / Ctrl Enter 提交").font(.caption2).foregroundStyle(.tertiary); Spacer(minLength: 0)
                        Button(friday: "取消") { remove(annotation.id) }.buttonStyle(FridayButtonStyle(compact: true))
                        Button(friday: "批注") { submit(annotation.id, text) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }.padding(10).onAppear { focused = true }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true).padding(.vertical, 4)
    }
}
