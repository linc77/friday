import SwiftUI
struct TaskReviewGuideNotices: View {
    @ObservedObject var store: FridayStore
    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ForEach(Array(store.reviewGuideNotices.suffix(3))) { notice in
                HStack(alignment: .top, spacing: 10) {
                    FridaySymbolImage(systemName: notice.status == "completed" ? "sparkles" : "exclamationmark.circle").foregroundStyle(notice.status == "completed" ? Color.accentColor : Color.orange)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(fridayString: notice.status == "completed" ? "Guide 已就绪" : "Guide 生成未完成").font(.callout.weight(.medium))
                        Text(notice.title).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        if let error = notice.error { Text(fridayString: error).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        Button(friday: "查看 Guide") { store.reviewGuideOpenRequest = .init(taskID: notice.taskID, url: notice.url); store.reviewGuideNotices.removeAll { $0.id == notice.id } }.buttonStyle(FridayButtonStyle(compact: true))
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Button { store.reviewGuideNotices.removeAll { $0.id == notice.id } } label: { FridaySymbolImage(systemName: "xmark").frame(width: 22, height: 22) }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "关闭"))
                }.padding(12).frame(width: 320).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary))
            }
        }
    }
}
