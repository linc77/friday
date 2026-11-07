import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

private struct MarkdownTaskToggleKey: EnvironmentKey { static let defaultValue: ((Int, Bool) -> Void)? = nil }
extension EnvironmentValues { var markdownTaskToggle: ((Int, Bool) -> Void)? { get { self[MarkdownTaskToggleKey.self] } set { self[MarkdownTaskToggleKey.self] = newValue } } }

struct AgentMarkdown: View {
    let text: String
    var compact = false
    var canOpenLocalFiles = false
    var workspacePath: String? = nil
    var isStreaming = false
    var galleryImages: [MarkdownImage]? = nil
    @State private var parsed: [MarkdownBlock]? = nil
    @State private var parsedSource: String? = nil
    @State private var scope = UUID()
    @State private var fragmentRequest: MarkdownFragmentRequest? = nil
    @Environment(\.markdownScrollTo) private var scrollTo
    @Environment(\.markdownMediaContext) private var mediaContext
    @Environment(\.taskFileOpen) private var fileOpen
    @Environment(\.taskBrowserOpen) private var browserOpen
    @Environment(\.markdownTaskToggle) private var taskToggle
    @Environment(\.taskCitationDocument) private var citationModel
    @State private var visibleImages: [MarkdownImage] = []
    @State private var imagePreview: MarkdownImagePreview?
    @State private var videoPreview: MarkdownVideoPreview?
    private var navigation: MarkdownNavigation { MarkdownNavigation(scope: scope, anchors: MarkdownNavigation.anchors(in: parsed ?? [])) }

    var body: some View {
        Group {
            if let parsed { MarkdownBlockGroup(blocks: parsed, compact: compact, canOpenLocalFiles: canOpenLocalFiles, workspacePath: workspacePath, isStreaming: isStreaming || parsedSource != text) }
            else { Text(verbatim: text) }
        }
        .font(compact ? .callout : .body).lineSpacing(compact ? 4 : 6)
        .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        .overlay { if let citationModel { TaskCitationSelectionOverlay(model:citationModel) } }
        .environment(\.markdownNavigation, navigation)
        .environment(\.markdownTaskToggle, parsedSource == text ? taskToggle : nil)
        .environment(\.markdownFragmentRequest, fragmentRequest)
        .environment(\.markdownExpandImage, { image in
            if let link = image.link, MarkdownMediaKind.video(link), case .remote(let url) = MarkdownMediaSource.classify(link, workspacePath: workspacePath) {
                videoPreview = MarkdownVideoPreview(image: MarkdownImage(source: url.absoluteString, alt: url.lastPathComponent, title: nil, link: nil))
            } else { imagePreview = MarkdownImageGallery.selection(image, visible: galleryImages ?? visibleImages) }
        })
        .onPreferenceChange(MarkdownVisibleImages.self) { visibleImages = $0 }
        .sheet(item: $imagePreview) { preview in MarkdownImageGalleryView(preview: preview, workspacePath: workspacePath, canOpenLocalFiles: canOpenLocalFiles) }
        .sheet(item: $videoPreview) { preview in MarkdownVideoPreviewView(preview: preview, workspacePath: workspacePath) }
        .onChange(of: mediaContext?.id) { _, _ in imagePreview = nil; videoPreview = nil; visibleImages = [] }
        .task(id: fragmentRequest) {
            guard let request = fragmentRequest, let target = navigation.target("#" + request.target) else { return }
            // Let every containing disclosure mount before resolving its scroll anchor.
            try? await Task.sleep(for: .milliseconds(100))
            if !Task.isCancelled { scrollTo?(target) }
        }
        .task(id: text) {
            let source = text
            let parsing = Task.detached(priority: .userInitiated) { MarkdownBlocks.parse(source) }
            let blocks = await withTaskCancellationHandler(operation: { await parsing.value }, onCancel: { parsing.cancel() })
            guard !Task.isCancelled else { return }; parsed = blocks; parsedSource = source
        }
        .environment(\.openURL, OpenURLAction { url in
            if let target = navigation.target(url.absoluteString) {
                fragmentRequest = MarkdownFragmentRequest(target: target.fragment); return .handled
            }
            if MarkdownMediaKind.video(url.absoluteString), MarkdownMediaSource.classify(url.absoluteString, workspacePath: workspacePath) != .blocked {
                if let fileOpen, let location = TaskFileNavigation.location(url.absoluteString, basePath: workspacePath, workspaceRoot: fileOpen.root) { fileOpen.open(location); return .handled }
                #if os(macOS)
                if !NSEvent.modifierFlags.intersection([.command, .control, .shift, .option]).isEmpty { return .systemAction(url) }
                #endif
                videoPreview = MarkdownVideoPreview(image: MarkdownImage(source: url.absoluteString, alt: url.lastPathComponent, title: nil, link: nil)); return .handled
            }
            if MarkdownImageGallery.isImageLink(url.absoluteString), case .remote = MarkdownMediaSource.classify(url.absoluteString, workspacePath: workspacePath) {
                #if os(macOS)
                if !NSEvent.modifierFlags.intersection([.command, .control, .shift, .option]).isEmpty { return .systemAction(url) }
                #endif
                imagePreview = MarkdownImageGallery.selection(MarkdownImage(source: url.absoluteString, alt: url.lastPathComponent, title: nil, link: nil), visible: galleryImages ?? visibleImages); return .handled
            }
            if let fileOpen, let location = TaskFileNavigation.location(url.absoluteString, basePath: workspacePath, workspaceRoot: fileOpen.root, allowHost: true) {
                if location.path.hasPrefix("/"), MarkdownImageGallery.isImageLink(url.absoluteString) {
                    imagePreview = MarkdownImageGallery.selection(MarkdownImage(source: url.absoluteString, alt: url.lastPathComponent, title: nil, link: nil), visible: visibleImages)
                } else { fileOpen.open(location) }
                return .handled
            }
            guard let target = MarkdownLinkPolicy.target(url.absoluteString, workspacePath: workspacePath, canOpenLocalFiles: canOpenLocalFiles) else { return .handled }
            #if os(macOS)
            if target.isFileURL { NSWorkspace.shared.open(target); return .handled }
            if !NSEvent.modifierFlags.intersection([.command,.control,.shift,.option]).isEmpty {return .systemAction(target)}
            #endif
            if browserOpen?(target)==true {return .handled}
            return .systemAction(target)
        })
    }
}

private struct MarkdownBlockGroup: View {
    let blocks: [MarkdownBlock]; let compact: Bool; let canOpenLocalFiles: Bool; let workspacePath: String?; let isStreaming: Bool
    @Environment(\.taskCitationPath) private var citationPath
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 10 : 16) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                MarkdownBlockView(block: block, compact: compact, canOpenLocalFiles: canOpenLocalFiles, workspacePath: workspacePath, isStreaming: isStreaming)
                    .environment(\.taskCitationPath,citationPath+[index])
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock; let compact: Bool; let canOpenLocalFiles: Bool; let workspacePath: String?; let isStreaming: Bool
    @Environment(\.markdownTaskToggle) private var taskToggle
    @Environment(\.taskCitationPath) private var citationPath
    private func inline(_ value: MarkdownInline,role:TaskCitationTextRole? = nil) -> MarkdownInlineView {
        MarkdownInlineView(value: value, compact: compact, canOpenLocalFiles: canOpenLocalFiles, workspacePath: workspacePath,role:role)
    }
    private func nested(_ blocks: [MarkdownBlock],suffix:[Int] = [1]) -> AnyView {
        AnyView(MarkdownBlockGroup(blocks: blocks, compact: compact, canOpenLocalFiles: canOpenLocalFiles, workspacePath: workspacePath, isStreaming: isStreaming).environment(\.taskCitationPath,citationPath+suffix))
    }
    var body: some View {
        switch block {
        case .paragraph(let value): inline(value)
        case .heading(let level, let value):
            inline(value,role:.heading(level)).font(level == 1 ? .title2.weight(.semibold) : level == 2 ? .title3.weight(.semibold) : .headline)
                .padding(.top, compact ? 4 : 10).accessibilityAddTraits(.isHeader)
        case .code(let fence):
            if fence.language == "mermaid" { MermaidCodeBlock(fence: fence, isStreaming: isStreaming) }
            else { AgentCodeBlock(language: fence.language, text: fence.text, title: fence.title) }
        case .list(let list):
            let width = list.start.map { CGFloat(String($0 + UInt(max(0, list.items.count - 1))).count + 1) * 8 + 3 } ?? 17
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(list.items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: 10) {
                        Group {
                            if let checked = item.checked {
                                if let taskToggle, let offset = item.markerOffset {
                                    Button { taskToggle(offset, !checked) } label: { FridaySymbolImage(systemName: checked ? "checkmark.square" : "square").font(.callout) }.buttonStyle(FridaySymbolButtonStyle())
                                        .accessibilityLabel(Text(friday: checked ? "标为未完成" : "标为已完成"))
                                } else {
                                    FridaySymbolImage(systemName: checked ? "checkmark.square" : "square").font(.callout)
                                        .accessibilityLabel(Text(friday: checked ? "已完成" : "未完成"))
                                }
                            } else { Text(list.start.map { "\($0 + UInt(index))." } ?? "•").monospacedDigit() }
                        }.foregroundStyle(.secondary).frame(minWidth: width, alignment: .trailing).padding(.top, 2)
                        nested(item.blocks,suffix:[1,index])
                    }
                }
            }
        case .quote(let blocks):
            HStack(alignment: .top, spacing: 12) {
                Rectangle().fill(.primary.opacity(0.16)).frame(width: 3)
                nested(blocks).foregroundStyle(.secondary).environment(\.taskCitationSecondary,true)
            }.fixedSize(horizontal: false, vertical: true)
        case .alert(let kind, let blocks):
            HStack(alignment: .top, spacing: 12) {
                Rectangle().fill(alertColor(kind)).frame(width: 3)
                VStack(alignment: .leading, spacing: 8) {
                    FridaySymbolLabel(friday: alertTitle(kind), systemImage: alertSymbol(kind)).fontWeight(.semibold).foregroundStyle(alertColor(kind))
                    nested(blocks)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.fixedSize(horizontal: false, vertical: true)
        case .rule: Divider().padding(.vertical, 4)
        case .table(let table):
            MarkdownTableView(table: table, compact: compact, canOpenLocalFiles: canOpenLocalFiles, workspacePath: workspacePath)
        case .html(let value): Text(verbatim: value).font(.system(.callout, design: .monospaced))
        case .details(let value): MarkdownDetailsView(value: value, content: nested(value.blocks)) {
            if value.summary.fragments.isEmpty { Text(friday: "详细内容") } else { inline(value.summary).environment(\.taskCitationDocument,nil) }
        }
        case .anchor(let id, let children): nested(children).modifier(MarkdownAnchors(ids: [id]))
        case .indent(let children): nested(children).padding(.leading, 20)
        }
    }
    private func alertTitle(_ kind: MarkdownAlert) -> String {
        switch kind { case .note: "说明"; case .tip: "提示"; case .important: "重要"; case .warning: "警告"; case .caution: "注意" }
    }
    private func alertSymbol(_ kind: MarkdownAlert) -> String {
        switch kind { case .note: "info.circle"; case .tip: "lightbulb"; case .important: "exclamationmark.bubble"; case .warning: "exclamationmark.triangle"; case .caution: "exclamationmark.octagon" }
    }
    private func alertColor(_ kind: MarkdownAlert) -> Color {
        switch kind { case .note: .blue; case .tip: .green; case .important: .purple; case .warning: .orange; case .caution: .red }
    }
}

private struct MarkdownInlineView: View {
    let value: MarkdownInline; let compact: Bool; let canOpenLocalFiles: Bool; let workspacePath: String?
    var role:TaskCitationTextRole? = nil
    var maximumLines:Int? = nil
    @Environment(\.taskCitationDocument) private var citationModel
    @Environment(\.taskCitationSecondary) private var citationSecondary
    @Environment(\.markdownNavigation) private var navigation
    @Environment(\.taskFileOpen) private var fileOpen
    private enum Part { case text([MarkdownRun]), image(MarkdownImage) }
    private var parts: [Part] {
        var parts: [Part] = [], runs: [MarkdownRun] = []
        for fragment in value.fragments {
            switch fragment {
            case .text(let run): runs.append(run)
            case .image(let image):
                if !runs.isEmpty { parts.append(.text(runs)); runs = [] }; parts.append(.image(image))
            }
        }
        if !runs.isEmpty { parts.append(.text(runs)) }; return parts
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
                switch part {
                case .text(let runs):
                    if citationModel != nil { TaskCitationSelectableText(value:TaskCitationTextStyle.runs(runs,role:role ?? (compact ? .callout:.body),links:runs.map { link($0.link) },secondary:citationSecondary),part:index,maximumLines:maximumLines) }
                    else { Text(attributed(runs)).frame(maxWidth: .infinity, alignment: .leading) }
                case .image(let image):
                    if MarkdownMediaKind.video(image.source) { MarkdownVideoView(image: image, workspacePath: workspacePath) }
                    else { MarkdownImageView(image: image, canOpenLocalFiles: canOpenLocalFiles, workspacePath: workspacePath) }
                }
            }
        }.modifier(MarkdownAnchors(ids: value.anchors))
    }
    private func attributed(_ runs: [MarkdownRun]) -> AttributedString {
        var result = AttributedString()
        for run in runs {
            var value = AttributedString(run.text); var intent: InlinePresentationIntent = []
            if run.style.contains(.strong) { intent.insert(.stronglyEmphasized) }
            if run.style.contains(.emphasis) { intent.insert(.emphasized) }
            if run.style.contains(.strike) { intent.insert(.strikethrough) }
            if run.style.contains(.code) { intent.insert(.code); value.font = .system(compact ? .callout : .body, design: .monospaced); value.backgroundColor = .primary.opacity(0.06) }
            if run.style.contains(.keyboard) { value.font = .system(.callout, design: .monospaced); value.backgroundColor = .primary.opacity(0.09) }
            if run.style.contains(.underline) { value.underlineStyle = .single }
            if run.style.contains(.subscriptText) { value.font = .caption; value.baselineOffset = -3 }
            if run.style.contains(.superscriptText) { value.font = .caption; value.baselineOffset = 5 }
            value.inlinePresentationIntent = intent
            if let link = run.link {
                value.link = navigation?.target(link) != nil ? URL(string: link)
                    : MarkdownMediaKind.video(link) ? MarkdownMediaKind.link(link, workspace: workspacePath)
                    : fileOpen?.target(link, basePath: workspacePath) ?? MarkdownLinkPolicy.target(link, workspacePath: workspacePath, canOpenLocalFiles: canOpenLocalFiles)
            }
            result.append(value)
        }
        return result
    }
    private func link(_ value:String?) -> URL? {
        guard let value else { return nil }
        return navigation?.target(value) != nil ? URL(string:value)
            : MarkdownMediaKind.video(value) ? MarkdownMediaKind.link(value,workspace:workspacePath)
            : fileOpen?.target(value,basePath:workspacePath) ?? MarkdownLinkPolicy.target(value,workspacePath:workspacePath,canOpenLocalFiles:canOpenLocalFiles)
    }
}

private struct MarkdownTableView: View {
    let table: MarkdownTable; let compact: Bool; let canOpenLocalFiles: Bool; let workspacePath: String?
    @State private var expanded = true
    @State private var copied = false
    @State private var copyID = UUID()
    @Environment(\.taskCitationPath) private var citationPath
    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            ScrollView(.horizontal) {
                Grid(alignment: .topLeading, horizontalSpacing: 24, verticalSpacing: 12) {
                    GridRow { ForEach(table.headers.indices, id: \.self) { cell(table.headers[$0],row:0,column:$0).fontWeight(table.headerIsStyled ? .semibold : .regular) } }
                    Divider().gridCellColumns(max(1, table.headers.count))
                    ForEach(table.rows.indices, id: \.self) { row in
                        GridRow { ForEach(table.headers.indices, id: \.self) { column in
                            cell(column < table.rows[row].count ? table.rows[row][column] : .text(""),row:row+1,column:column)
                        } }
                    }
                }.padding(14)
            }.background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
            HStack(spacing: 12) {
                Button { expanded.toggle() } label: { FridaySymbolImage(systemName: expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") }
                    .buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: expanded ? "收起表格单元格" : "展开表格单元格"))
                    .accessibilityLabel(Text(friday: expanded ? "收起表格单元格" : "展开表格单元格"))
                    .accessibilityValue(Text(friday: expanded ? "已展开" : "已收起"))
                Spacer()
                Menu {
                    Button(friday: "复制为 Markdown") { copy(table.markdown) }
                    Button(friday: "复制为 CSV") { copy(table.csv) }
                } label: { FridaySymbolImage(systemName: copied ? "checkmark" : "doc.on.doc") }
                    #if os(macOS)
                    .menuStyle(.borderlessButton).fixedSize()
                    #endif
                    .fridayInteractiveCursor().help(Text(friday: copied ? "已复制" : "复制表格"))
                    .accessibilityLabel(Text(friday: copied ? "已复制" : "复制表格"))
            }.font(.caption).foregroundStyle(.secondary)
        }.task(id: copyID) {
            guard copied else { return }; try? await Task.sleep(for: .milliseconds(1200))
            if !Task.isCancelled { copied = false }
        }
    }
    private func cell(_ value: MarkdownInline,row:Int,column: Int) -> some View {
        let alignment = column < table.alignments.count ? table.alignments[column] : .left
        return MarkdownInlineView(value: value, compact: compact, canOpenLocalFiles: canOpenLocalFiles, workspacePath: workspacePath,maximumLines:expanded ? nil:1)
            .environment(\.taskCitationPath,citationPath+[2,row,column])
            .lineLimit(expanded ? nil : 1).frame(minWidth: 70, maxWidth: 320, alignment: alignment == .right ? .trailing : alignment == .center ? .center : .leading)
            .gridColumnAlignment(alignment == .right ? .trailing : alignment == .center ? .center : .leading)
    }
    private func copy(_ value: String) { copyAgentText(value); copied = true; copyID = UUID() }
}

struct AgentCodeBlock: View {
    var language = ""
    let text: String
    var title: String? = nil
    var headerActions: AnyView? = nil
    var copyControl: AnyView? = nil
    var wrapping: Binding<Bool>? = nil
    @State private var copied = false
    @State private var copyID = UUID()
    @State private var wrapped = true
    private var wrap: Binding<Bool> { wrapping ?? $wrapped }
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.taskCitationDocument) private var citationModel
    @State private var highlighted: CodeHighlight? = nil
    @State private var highlightedKey: HighlightKey? = nil
    private struct HighlightKey: Hashable { let text: String; let language: String; let dark: Bool }
    private var highlightKey: HighlightKey { HighlightKey(text: text, language: language, dark: colorScheme == .dark) }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                Text(verbatim: title ?? (language.isEmpty ? "text" : language)).font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                Spacer()
                if let headerActions { headerActions }
                Button { wrap.wrappedValue.toggle() } label: { FridaySymbolImage(systemName: "arrow.turn.down.left") }
                    .buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: wrap.wrappedValue ? "取消自动换行" : "自动换行"))
                    .accessibilityLabel(Text(friday: wrap.wrappedValue ? "取消自动换行" : "自动换行"))
                    .accessibilityValue(Text(friday: wrap.wrappedValue ? "已启用" : "已关闭"))
                if let copyControl { copyControl }
                else { Button { copyAgentText(text); copied = true; copyID = UUID() } label: { FridaySymbolImage(systemName: copied ? "checkmark" : "doc.on.doc") }
                    .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: copied ? "已复制" : "复制代码"))
                }
            }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            if wrap.wrappedValue { code.fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading) }
            else { ScrollView(.horizontal) { code.fixedSize(horizontal: true, vertical: true) } }
        }.background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.primary.opacity(0.06)))
            .task(id: copyID) {
                guard copied else { return }; try? await Task.sleep(for: .milliseconds(1200))
                if !Task.isCancelled { copied = false }
            }.onChange(of: text) { _, _ in copied = false }
            .task(id: highlightKey) {
                let key = highlightKey
                let value = await CodeHighlighter.shared.highlight(text, language: language, dark: key.dark)
                guard !Task.isCancelled else { return }; highlighted = value; highlightedKey = key
            }
    }
    private var code: some View {
        Group {
            if citationModel != nil { TaskCitationSelectableText(value:TaskCitationTextStyle.code(text,highlight:highlightedKey == highlightKey ? highlighted:nil),part:0) }
            else { Text(highlightedText).font(.system(.callout, design: .monospaced)).lineSpacing(4).textSelection(.enabled) }
        }.padding(14)
    }
    private var highlightedText: AttributedString {
        guard highlightedKey == highlightKey, let highlighted else { return AttributedString(text) }
        var result = AttributedString()
        for token in highlighted.tokens {
            var value = AttributedString(token.text)
            var font = Font.system(.callout, design: .monospaced).weight(token.style & 2 != 0 ? .bold : .regular)
            if token.style & 1 != 0 { font = font.italic() }
            value.font = font; value.foregroundColor = codeColor(token.color)
            if token.style & 4 != 0 { value.underlineStyle = Text.LineStyle(pattern: .solid) }
            if token.style & 8 != 0 { value.strikethroughStyle = Text.LineStyle(pattern: .solid) }
            result.append(value)
        }
        return result
    }
    private func codeColor(_ hex: String) -> Color {
        let value = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard value.count == 6 || value.count == 8, let number = UInt64(value, radix: 16) else { return .primary }
        let rgb = value.count == 8 ? number >> 8 : number
        return Color(.sRGB, red: Double(rgb >> 16 & 255) / 255, green: Double(rgb >> 8 & 255) / 255, blue: Double(rgb & 255) / 255, opacity: value.count == 8 ? Double(number & 255) / 255 : 1)
    }
}

func copyAgentText(_ text: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}
