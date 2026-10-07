import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct AgentMarkdown: View {
    let text: String
    var compact = false
    var canOpenLocalFiles = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 10 : 16) {
            ForEach(Array(MarkdownBlocks.parse(text).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .font(compact ? .callout : .body).lineSpacing(compact ? 4 : 6)
        .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        .environment(\.openURL, OpenURLAction { url in
            #if os(macOS)
            if url.isFileURL || (url.scheme == nil && url.path.hasPrefix("/")) {
                guard canOpenLocalFiles else { return .handled }
                let path = url.path.replacingOccurrences(of: ":\\d+(?::\\d+)?$", with: "", options: .regularExpression)
                NSWorkspace.shared.open(URL(fileURLWithPath: path)); return .handled
            }
            #endif
            return .systemAction
        })
    }

    private func inline(_ value: String) -> Text {
        Text((try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value))
    }

    @ViewBuilder private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let value): inline(value)
        case .heading(let level, let value):
            inline(value).font(level == 1 ? .title2.weight(.semibold) : level == 2 ? .title3.weight(.semibold) : .headline)
                .padding(.top, compact ? 4 : 10)
        case .list(let marker, let value, let indent):
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(marker).foregroundStyle(.secondary).frame(minWidth: 14, alignment: .trailing)
                inline(value).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.leading, CGFloat(indent * 14))
        case .quote(let value):
            HStack(spacing: 12) {
                Rectangle().fill(.primary.opacity(0.16)).frame(width: 3)
                inline(value).foregroundStyle(.secondary)
            }.fixedSize(horizontal: false, vertical: true)
        case .rule: Divider().padding(.vertical, 4)
        case .code(let language, let value): AgentCodeBlock(language: language, text: value)
        case .table(let headers, let rows):
            ScrollView(.horizontal) {
                Grid(alignment: .topLeading, horizontalSpacing: 22, verticalSpacing: 12) {
                    GridRow { ForEach(headers.indices, id: \.self) { inline(headers[$0]).fontWeight(.semibold) } }
                    Divider().gridCellColumns(headers.count)
                    ForEach(rows.indices, id: \.self) { index in
                        GridRow { ForEach(headers.indices, id: \.self) { column in
                            inline(column < rows[index].count ? rows[index][column] : "").frame(maxWidth: 320, alignment: .leading)
                        } }
                    }
                }.padding(14)
            }.background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}

struct AgentCodeBlock: View {
    var language = ""
    let text: String
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "Code" : language).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button { copyAgentText(text); copied = true } label: {
                    FridaySymbolImage(systemName: copied ? "checkmark" : "doc.on.doc")
                }.buttonStyle(FridaySymbolButtonStyle()).font(.caption).foregroundStyle(.secondary)
                    .accessibilityLabel(Text(friday: copied ? "已复制" : "复制代码"))
            }.padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            ScrollView(.horizontal) {
                Text(verbatim: text).font(.system(.callout, design: .monospaced)).lineSpacing(4)
                    .fixedSize(horizontal: true, vertical: false).textSelection(.enabled).padding(14)
            }
        }.background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.primary.opacity(0.06)))
            .onChange(of: text) { _, _ in copied = false }
    }
}

func copyAgentText(_ text: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}
