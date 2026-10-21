import SwiftUI

struct TaskReviewThreadCard: View {
    let thread: TaskChangeRequestActivityResponse.Thread
    let canResolve: Bool; let canReply: Bool; let busy: Bool; let loadingMore: Bool
    let reply: () -> Void; let resolve: () -> Void; let edit: (TaskChangeRequestActivityResponse.Comment) -> Void; let loadMore: () -> Void
    var reactionValues: ((TaskChangeRequestActivityResponse.Comment) -> [TaskReviewReaction])? = nil
    var react: ((String, String, Bool) -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(thread.path + (thread.line.map { ":\($0)" } ?? "")).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    HStack(spacing: 8) {
                        Text(fridayString: thread.isResolved ? "已解决" : "待解决")
                        if thread.isOutdated { Text(friday: "旧版本") }
                        Text(String(thread.commentCount)); Text(friday: "条评论")
                    }.font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if canResolve, thread.canResolve != false {
                    Button(friday: thread.isResolved ? "重新打开线程" : "解决线程") { resolve() }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy)
                }
            }
            ForEach(thread.comments) { comment in
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text(comment.author).font(.callout).fontWeight(.medium)
                        Text(comment.createdAt.prefix(16).replacingOccurrences(of: "T", with: " ")).font(.caption).foregroundStyle(.secondary)
                        if comment.editedAt != nil { Text(friday: "已编辑").font(.caption2).foregroundStyle(.secondary) }
                        Spacer()
                        if comment.canEdit == true { Button { edit(comment) } label: { FridaySymbolImage(systemName: "pencil").frame(width: 20, height: 20) }.buttonStyle(FridaySymbolButtonStyle()).disabled(busy).help(Text(friday: "编辑评论")) }
                    }
                    TaskChangeRequestMarkdown(text: comment.body, compact: true)
                    if let react { TaskReviewReactionsBar(reactions: reactionValues?(comment) ?? comment.reactions ?? [], enabled: !busy) { content, reacted in react(comment.id, content, reacted) } }
                }.padding(.vertical, 4)
            }
            HStack {
                if canReply { Button(friday: "回复线程") { reply() }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy) }
                if thread.nextCursor != nil { Button(friday: loadingMore ? "正在读取评论" : "更多评论") { loadMore() }.buttonStyle(FridayButtonStyle(compact: true)).disabled(loadingMore) }
                Spacer()
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(thread.isResolved ? 0.2 : 0.35), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct TaskChangeRequestEditorTarget: Identifiable {
    let id = UUID()
    let key: String; let action: String; var threadID: String? = nil; var commentID: String? = nil; var commentKind: String? = nil
}
struct TaskChangeRequestEditor: View {
    let target: TaskChangeRequestEditorTarget
    @Binding var draft: TaskChangeRequestEditorDraft
    let busy: Bool; let error: String?; let close: () -> Void; let submit: () -> Void
    var retry: (() -> Void)? = nil
    var isSending = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(fridayString: target.action == "reply" ? "回复线程" : target.action == "edit_comment" ? "编辑评论" : "编辑 PR／MR").font(.headline)
            if target.action == "edit_request" { TextField(friday: "标题", text: $draft.title).textFieldStyle(.roundedBorder) }
            TextEditor(text: $draft.body).font(.body).frame(minHeight: 150, idealHeight: 240).overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                .accessibilityLabel(Text(fridayString: target.action == "edit_request" ? "描述" : "评论内容"))
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                if isSending { Text(friday: "正在发送平台操作").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button(friday: "关闭", action: close).buttonStyle(FridayButtonStyle(compact: true))
                if let retry { Button(friday: "重试发送", action: retry).buttonStyle(FridayButtonStyle(compact: true)) }
                Button(friday: target.action == "reply" ? "发送回复" : "保存修改", action: submit).buttonStyle(FridayButtonStyle(prominent: true, compact: true))
                    .disabled(busy || (target.action == "edit_request" ? draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.changeRequestFields.networkValue.isEmpty : draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }
        }.padding(20).frame(minWidth: 320, idealWidth: 620, minHeight: 300)
    }
}

struct TaskChangeRequestCandidateSheet: Identifiable { let id: String; let generation = UUID() }
struct TaskChangeRequestManualReviewers: View {
    let reviewers: [String]; let busy: Bool; let error: String?
    let close: () -> Void; let submit: (String, Bool) -> Void
    @State private var reviewer = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(friday: "请求审查").font(.headline)
            TextField(friday: "审查者账号或邮箱", text: $reviewer).textFieldStyle(.roundedBorder).disabled(busy)
            Button(friday: "添加审查者") { submit(reviewer.trimmingCharacters(in: .whitespacesAndNewlines), true) }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(busy || reviewer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            ForEach(reviewers, id: \.self) { value in HStack { Text(value); Spacer(); Button(friday: "移除") { submit(value, false) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy) } }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
            HStack { Spacer(); Button(friday: "关闭", action: close).buttonStyle(FridayButtonStyle(compact: true)) }
        }.padding(20).frame(minWidth: 320, idealWidth: 520)
    }
}
struct TaskChangeRequestCandidateRow: Identifiable {
    let id: String; let title: String; let subtitle: String?; let selected: Bool
}
struct TaskChangeRequestCandidatePicker: View {
    let kind: String; let rows: [TaskChangeRequestCandidateRow]; let truncated: Bool; let loading: Bool; let busy: Bool; let error: String?
    let refresh: () -> Void; let close: () -> Void; let toggle: (String) -> Void
    var retry: (() -> Void)? = nil
    var isSending = false
    @State private var query = ""
    private var matches: [TaskChangeRequestCandidateRow] { rows.filter { query.isEmpty || ($0.title + " " + ($0.subtitle ?? "")).localizedCaseInsensitiveContains(query) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(fridayString: kind == "reviewers" ? "请求审查" : "管理标签").font(.headline)
                Spacer()
                Button(action: refresh) { FridaySymbolImage(systemName: "arrow.clockwise").frame(width: 22, height: 22) }.buttonStyle(FridaySymbolButtonStyle()).disabled(loading || busy).help(Text(friday: "刷新"))
            }
            TextField(friday: "搜索", text: $query).textFieldStyle(.roundedBorder)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    if loading { Text(friday: "正在读取候选列表").foregroundStyle(.secondary).padding(12) }
                    ForEach(matches) { row in
                        Button { toggle(row.id) } label: {
                            HStack {
                                FridaySymbolImage(systemName: row.selected ? "checkmark.circle.fill" : "circle").foregroundStyle(row.selected ? Color.accentColor : Color.secondary)
                                VStack(alignment: .leading, spacing: 3) { Text(row.title); if let subtitle = row.subtitle, !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2) } }
                                Spacer()
                            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(FridaySymbolButtonStyle()).disabled(loading || busy)
                    }
                    if !loading, matches.isEmpty { Text(friday: "没有匹配的候选项").foregroundStyle(.secondary).padding(12) }
                    if truncated { Text(friday: "候选列表已截断，更多选项可在平台管理").font(.caption).foregroundStyle(.secondary).padding(8) }
                }
            }.frame(minHeight: 180, idealHeight: 330)
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            HStack { if isSending { Text(friday: "正在发送平台操作").font(.caption).foregroundStyle(.secondary) }; Spacer(); if let retry { Button(friday: "重试发送", action: retry).buttonStyle(FridayButtonStyle(compact: true)) }; Button(friday: "关闭", action: close).buttonStyle(FridayButtonStyle(compact: true)) }
        }.padding(20).frame(minWidth: 320, idealWidth: 480)
    }
}
