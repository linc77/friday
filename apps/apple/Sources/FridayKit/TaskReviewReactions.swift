import SwiftUI

struct TaskReviewReactionsBar: View {
    let reactions: [TaskReviewReaction]; let enabled: Bool; let react: (String, Bool) -> Void
    var body: some View {
        HStack(spacing: 5) {
            ForEach(reactions) { reaction in
                Button { react(reaction.content, !reaction.viewerHasReacted) } label: {
                    HStack(spacing: 4) { FridaySymbolImage(systemName: TaskReviewReactionPresentation.symbol(reaction.content)); Text(String(reaction.count)).monospacedDigit() }
                        .font(.caption).padding(.horizontal, 6).padding(.vertical, 4).background(reaction.viewerHasReacted ? Color.accentColor.opacity(0.13) : Color.clear, in: Capsule())
                }.buttonStyle(FridaySymbolButtonStyle()).disabled(!enabled)
                    .help(Text(verbatim: tooltip(reaction)))
                    .accessibilityLabel(Text(fridayString: TaskReviewReactionPresentation.title(reaction.content)))
            }
            Menu {
                ForEach(TaskReviewReactionPresentation.order, id: \.self) { content in
                    Button(friday: TaskReviewReactionPresentation.title(content), systemImage: TaskReviewReactionPresentation.symbol(content)) { react(content, !(reactions.first { $0.content == content }?.viewerHasReacted ?? false)) }
                }
            } label: { FridaySymbolImage(systemName: "face.smiling").font(.caption).frame(width: 25, height: 25) }
                .menuStyle(.borderlessButton).fixedSize().fridayInteractiveCursor().disabled(!enabled).accessibilityLabel(Text(friday: "添加表情反应"))
        }
    }
    private func tooltip(_ reaction: TaskReviewReaction) -> String {
        var names = reaction.actors
        if reaction.viewerHasReacted, names.count < reaction.count { names.insert(String(localized: "你", bundle: .module), at: 0) }
        let shown = Array(names.prefix(min(3, reaction.count))), others = max(0, reaction.count - shown.count)
        return shown.joined(separator: ", ") + (others > 0 ? " +\(others)" : "") + " · " + String(localized: String.LocalizationValue(TaskReviewReactionPresentation.title(reaction.content)), bundle: .module)
    }
}
