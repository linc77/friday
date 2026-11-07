import SwiftUI

struct TaskGuideExcerptView: View {
    let snapshot: TaskGuideExcerptSnapshot; let notes: [TaskReviewGuide.Note]; let comments: [TaskRemoteReviewDraft]
    let canComment: Bool; let openFile: () -> Void; let ask: () -> Void
    let submit: (TaskGuideExcerptSnapshot.Line, String) -> Void; let remove: (UUID) -> Void
    @State private var editing: TaskGuideExcerptSnapshot.Line?
    @State private var draft = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Button(action: openFile) { Text(snapshot.path).font(.system(.caption, design: .monospaced)).lineLimit(1) }.buttonStyle(FridaySymbolButtonStyle())
                Text("\(snapshot.start)–\(snapshot.end)").font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                if snapshot.side == "old" { Text(friday: "修改前").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button(action: ask) { FridaySymbolImage(systemName: "questionmark.bubble").frame(width: 24, height: 24) }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "询问此段代码"))
            }.padding(10)
            if !snapshot.caption.isEmpty { Text(snapshot.caption).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.bottom, 8) }
            Divider()
            if snapshot.unavailable == true { Text(friday: "此摘录暂不可用，仍可打开文件查看").font(.caption).foregroundStyle(.secondary).padding(10) }
            else {
                ForEach(snapshot.lines) { line in
                    HStack(alignment: .top, spacing: 8) {
                        Text(String(line.number)).foregroundStyle(.secondary).frame(width: 42, alignment: .trailing)
                        Text(line.text.isEmpty ? " " : line.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        if line.position != nil {
                            Button { draft = ""; editing = line } label: { FridaySymbolImage(systemName: "text.bubble").frame(width: 22, height: 22) }.buttonStyle(FridaySymbolButtonStyle()).disabled(!canComment).help(Text(friday: "添加审查意见"))
                        }
                    }.font(.system(.caption, design: .monospaced)).padding(.horizontal, 6).padding(.vertical, 3)
                        .background(line.position == nil ? Color.clear : (snapshot.side == "old" ? Color.red.opacity(0.07) : Color.green.opacity(0.07)))
                    ForEach(Array(notes.enumerated()).filter { $0.element.line == line.number }, id: \.offset) { _, note in
                        VStack(alignment: .leading, spacing: 5) { Text(note.title).font(.caption.weight(.medium)); if !note.body.isEmpty { AgentMarkdown(text: note.body, compact: true) } }.padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Color.accentColor.opacity(0.06))
                    }
                    ForEach(comments.filter { value in value.position.selectedLine == line.number }) { value in
                        HStack(alignment: .top) { AgentMarkdown(text: value.body, compact: true); Spacer(); Button { remove(value.id) } label: { FridaySymbolImage(systemName: "trash").frame(width: 22, height: 22) }.buttonStyle(FridaySymbolButtonStyle()).disabled(!canComment).help(Text(friday: "删除批注")) }.padding(10)
                    }
                }
            }
        }.background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 8)).clipShape(RoundedRectangle(cornerRadius: 8))
        .popover(item: $editing) { line in
            VStack(alignment: .leading, spacing: 10) {
                Text(snapshot.path + ":" + String(line.number)).font(.system(.caption, design: .monospaced))
                TextEditor(text: $draft).font(.body).frame(minWidth: 280, minHeight: 100).accessibilityLabel(Text(friday: "审查意见"))
                HStack { Button(friday: "取消") { editing = nil }.buttonStyle(FridayButtonStyle(compact: true)); Spacer(); Button(friday: "加入审查草稿") { submit(line, draft); draft = ""; editing = nil }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(!canComment || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }.padding(14)
        }
    }
}
