import SwiftUI

struct MarkdownDetailsView<Summary: View>: View {
    let value: MarkdownDetails
    let content: AnyView
    let summary: () -> Summary
    @State private var expanded: Bool
    @Environment(\.markdownFragmentRequest) private var fragmentRequest
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    init(value: MarkdownDetails, content: AnyView, @ViewBuilder summary: @escaping () -> Summary) {
        self.value = value; self.content = content; self.summary = summary
        _expanded = State(initialValue: value.initiallyOpen)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider()
            Button {
                withAnimation(reduceMotion ? nil : FridayTheme.motion) { expanded.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    FridaySymbolImage(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption).foregroundStyle(.secondary)
                    summary().fontWeight(.medium)
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle()).padding(.vertical, 9)
            }.buttonStyle(FridaySymbolButtonStyle()).accessibilityValue(Text(friday: expanded ? "已展开" : "已收起"))
            if expanded { content.padding(.leading, 24).padding(.bottom, 12) }
            Divider()
        }
        .onChange(of: fragmentRequest, initial: true) { _, request in
            if let request, MarkdownNavigation.anchors(in: value.blocks).contains(request.target) { expanded = true }
        }
    }
}
