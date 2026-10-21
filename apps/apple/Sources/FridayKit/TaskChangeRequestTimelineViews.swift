import SwiftUI

struct TaskTimelineDate: View {
    let value: String
    var body: some View {
        Group {
            if let date = TaskChangeRequestTimeline.date(value) { Text(date, style: .relative) }
            else { Text(value.prefix(16).replacingOccurrences(of: "T", with: " ")) }
        }.font(.caption).foregroundStyle(.secondary).help(Text(value))
    }
}
private struct TaskTimelineMarker: View {
    let url: String?; let symbol: String
    var body: some View {
        Group {
            if let url, let address = URL(string: url), address.scheme == "https" {
                AsyncImage(url: address) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() }
                    else { FridaySymbolImage(systemName: symbol).foregroundStyle(.secondary) }
                }
            } else { FridaySymbolImage(systemName: symbol).foregroundStyle(.secondary) }
        }.frame(width: 26, height: 26).background(.background, in: Circle()).clipShape(Circle()).accessibilityHidden(true)
    }
}
struct TaskChangeRequestTimelineList: View {
    let detail: TaskChangeRequestDetail?; let activity: TaskChangeRequestActivityResponse?; let loading: Bool; let error: String?
    let comment: (TaskChangeRequestActivityResponse.Item) -> AnyView
    let thread: (TaskChangeRequestActivityResponse.Thread) -> AnyView
    let openCommit: (TaskChangeRequestCommit) -> Void
    let footer: AnyView
    @State private var newestFirst = true
    @State private var expanded = Set<String>()
    private var entries: [TaskChangeRequestTimelineEntry] { TaskChangeRequestTimeline.entries(detail: detail, activity: activity, newestFirst: newestFirst) }
    var body: some View {
        let events = entries
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(friday: "时间线").font(.headline); Spacer()
                    Button { newestFirst.toggle() } label: {
                        Label { Text(fridayString: newestFirst ? "最新在前" : "最早在前") } icon: { FridaySymbolImage(systemName: "arrow.up.arrow.down") }
                    }.buttonStyle(FridayButtonStyle(compact: true))
                }
                if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
                if loading { Text(friday: "正在读取时间线").foregroundStyle(.secondary) }
                if activity?.commitsUnavailable == true { Text(friday: "提交记录暂不可用，评论仍可查看").font(.caption).foregroundStyle(.orange) }
                if activity?.commitsTruncated == true { Text(friday: "仅显示近期提交，完整记录可在平台查看").font(.caption).foregroundStyle(.secondary) }
                if activity?.dismissalsTruncated == true { Text(friday: "部分审查撤销原因未能读取").font(.caption).foregroundStyle(.secondary) }
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(TaskChangeRequestTimeline.rows(events)) { row in
                        if row.isConversation { conversation(row) }
                        else { ForEach(row.entries) { event($0) } }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).background(alignment: .leading) { Rectangle().fill(.quaternary).frame(width: 1).padding(.leading, 13) }
                if events.isEmpty, !loading, activity != nil { Text(friday: "暂无活动").font(.caption).foregroundStyle(.secondary) }
                if activity?.truncated == true { Text(friday: "时间线较长，完整内容可在平台查看").font(.caption).foregroundStyle(.secondary) }
                footer
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func conversation(_ row: TaskChangeRequestTimelineRow) -> some View {
        HStack(alignment: .top, spacing: 12) {
            TaskTimelineMarker(url: row.entries.first?.item?.authorAvatarURL, symbol: "text.bubble")
            VStack(alignment: .leading, spacing: 8) {
                Button { if expanded.contains(row.id) { expanded.remove(row.id) } else { expanded.insert(row.id) } } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(String(row.commentCount) + " " + String(localized: "条评论", bundle: .module)).font(.callout).fontWeight(.medium)
                            HStack(spacing: 6) { Text(String(row.authorCount) + " " + String(localized: "位参与者", bundle: .module)); if let first = row.entries.first { TaskTimelineDate(value: first.createdAt) } }.font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        FridaySymbolImage(systemName: expanded.contains(row.id) ? "chevron.up" : "chevron.down").font(.caption)
                    }.contentShape(Rectangle())
                }.buttonStyle(FridaySymbolButtonStyle()).accessibilityValue(Text(friday: expanded.contains(row.id) ? "已展开" : "已折叠"))
                if expanded.contains(row.id) { VStack(alignment: .leading, spacing: 8) { ForEach(row.entries) { entry in if let item = entry.item { comment(item) }; if let value = entry.thread { thread(value) } } } }
            }

        }
    }
    @ViewBuilder private func event(_ entry: TaskChangeRequestTimelineEntry) -> some View {
        if let value = entry.commit {
            Button { openCommit(value) } label: {
                HStack(alignment: .top, spacing: 12) {
                    TaskTimelineMarker(url: value.authors.first?.avatarURL, symbol: "checkmark.circle")
                    VStack(alignment: .leading, spacing: 5) {
                        Text(value.messageHeadline.isEmpty ? String(localized: "未命名提交", bundle: .module) : value.messageHeadline).font(.callout).fontWeight(.medium).lineLimit(2)
                        HStack(spacing: 8) { Text(value.oid.prefix(7)).font(.system(.caption, design: .monospaced)); TaskTimelineDate(value: value.committedDate) }.foregroundStyle(.secondary)
                        if !value.authors.isEmpty { Text(value.authors.map { $0.name ?? $0.login }.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    if let additions = value.additions, let deletions = value.deletions { Text("+\(additions)  −\(deletions)").font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary) }
                }.contentShape(Rectangle())
            }.buttonStyle(FridaySymbolButtonStyle()).disabled(detail?.capabilities?.commitDiff == false).help(Text(friday: "查看此提交的文件改动"))
        } else if let item = entry.item {
            HStack(alignment: .top, spacing: 12) { TaskTimelineMarker(url: item.authorAvatarURL, symbol: "person.crop.circle"); comment(item) }
        } else if let value = entry.thread {
            HStack(alignment: .top, spacing: 12) { TaskTimelineMarker(url: nil, symbol: "text.bubble"); thread(value) }
        } else {
            HStack(alignment: .top, spacing: 12) {
                TaskTimelineMarker(url: entry.kind == "opened" ? detail?.authorAvatarURL : nil, symbol: entry.kind == "merged" ? "arrow.triangle.merge" : entry.kind == "closed" ? "xmark.circle" : "plus.circle")
                VStack(alignment: .leading, spacing: 5) {
                    HStack { if entry.kind == "opened", let detail { Text(detail.author).fontWeight(.medium) }; Text(fridayString: entry.kind == "merged" ? "PR／MR 已合并" : entry.kind == "closed" ? "PR／MR 已关闭" : "创建了此 PR／MR") }.font(.callout)
                    TaskTimelineDate(value: entry.createdAt)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
