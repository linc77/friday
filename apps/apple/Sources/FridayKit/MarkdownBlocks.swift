import Foundation
import Markdown

struct MarkdownStyle: OptionSet, Equatable, Sendable {
    let rawValue: Int
    static let strong = Self(rawValue: 1), emphasis = Self(rawValue: 2), code = Self(rawValue: 4), strike = Self(rawValue: 8)
    static let underline = Self(rawValue: 16), keyboard = Self(rawValue: 32), subscriptText = Self(rawValue: 64), superscriptText = Self(rawValue: 128)
}
struct MarkdownRun: Equatable, Sendable {
    var text: String
    var style: MarkdownStyle = []
    var link: String? = nil
}
struct MarkdownImage: Equatable, Sendable {
    let source: String; let alt: String; let title: String?; let link: String?
    var galleryID: String? = nil
    var width: Double? = nil
    var height: Double? = nil
}
enum MarkdownFragment: Equatable, Sendable {
    case text(MarkdownRun), image(MarkdownImage)
    var plainText: String { switch self { case .text(let run): run.text; case .image(let image): image.alt } }
}
struct MarkdownInline: Equatable, Sendable {
    var fragments: [MarkdownFragment]
    var markdown: String? = nil
    var anchors: [String] = []
    var plainText: String { fragments.map(\.plainText).joined() }
    var markdownText: String { markdown ?? plainText }
    static func text(_ value: String) -> Self { Self(fragments: [.text(MarkdownRun(text: value))]) }
    func droppingFirst(_ count: Int) -> Self {
        var remaining = count
        return Self(fragments: fragments.compactMap { fragment in
            guard remaining > 0 else { return fragment }
            switch fragment {
            case .text(var run):
                let removed = min(remaining, run.text.count); remaining -= removed; run.text = String(run.text.dropFirst(removed))
                return run.text.isEmpty ? nil : .text(run)
            case .image: return fragment
            }
        })
    }
}
struct MarkdownFence: Equatable, Sendable {
    let language: String; let title: String?; let text: String
    init(info: String, text: String) {
        let pieces = info.split(maxSplits: 1, whereSeparator: \.isWhitespace)
        let raw = pieces.first.map(String.init) ?? "text"; language = raw == "gitignore" ? "ini" : raw
        let metadata = pieces.count > 1 ? String(pieces[1]) : ""
        let expression = try! NSRegularExpression(pattern: #"(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))"#, options: .caseInsensitive)
        if let match = expression.firstMatch(in: metadata, range: NSRange(metadata.startIndex..., in: metadata)),
           let range = (1...3).compactMap({ Range(match.range(at: $0), in: metadata) }).first {
            title = String(metadata[range])
        } else { title = metadata.split(whereSeparator: \.isWhitespace).first { $0.range(of: #"^[\w@][\w@./-]*\.[A-Za-z0-9]+$"#, options: .regularExpression) != nil }.map(String.init) }
        self.text = text
    }
}
struct MarkdownListItem: Equatable, Sendable { let checked: Bool?; let blocks: [MarkdownBlock]; var markerOffset: Int? = nil }
struct MarkdownList: Equatable, Sendable { let start: UInt?; let items: [MarkdownListItem] }
enum MarkdownAlignment: String, Equatable, Sendable { case left, center, right }
struct MarkdownTable: Equatable, Sendable {
    let headers: [MarkdownInline]; let rows: [[MarkdownInline]]; let alignments: [MarkdownAlignment]
    var headerIsStyled = true
    var markdown: String {
        func row(_ cells: [String]) -> String { "| " + cells.map { $0.replacingOccurrences(of: "\n+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "|", with: "\\|") }.joined(separator: " | ") + " |" }
        let separator = alignments.map { $0 == .center ? ":---:" : $0 == .right ? "---:" : "---" }
        return ([row(headers.map(\.markdownText)), row(separator)] + rows.map { row($0.map(\.markdownText)) }).joined(separator: "\n")
    }
    var csv: String {
        ([headers] + rows).map { row in row.map { cell in
            let value = cell.plainText.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
            return value.contains(where: { ",\"\r\n".contains($0) }) ? "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\"" : value
        }.joined(separator: ",") }.joined(separator: "\n")
    }
}
enum MarkdownAlert: String, Equatable, Sendable, CaseIterable { case note = "NOTE", tip = "TIP", important = "IMPORTANT", warning = "WARNING", caution = "CAUTION" }
struct MarkdownDetails: Equatable, Sendable { let summary: MarkdownInline; let initiallyOpen: Bool; let blocks: [MarkdownBlock] }
indirect enum MarkdownBlock: Equatable, Sendable {
    case paragraph(MarkdownInline), heading(Int, MarkdownInline), code(MarkdownFence), list(MarkdownList)
    case quote([MarkdownBlock]), alert(MarkdownAlert, [MarkdownBlock]), rule, table(MarkdownTable), html(String)
    case details(MarkdownDetails), anchor(String, [MarkdownBlock]), indent([MarkdownBlock])
}

enum MarkdownBlocks {
    static func parse(_ text: String) -> [MarkdownBlock] {
        guard !Task.isCancelled else { return [] }
        if let parsed = NativeMarkdownParser.shared.parse(text) { return parsed }
        guard !Task.isCancelled else { return [] }
        return blocks(Document(parsing: text, options: [.disableSmartOpts]))
    }
    private static func blocks(_ node: any Markup) -> [MarkdownBlock] { node.children.compactMap(block) }
    private static func block(_ node: any Markup) -> MarkdownBlock? {
        switch node {
        case let value as Paragraph: return .paragraph(inline(value))
        case let value as Heading: return .heading(value.level, inline(value))
        case let value as CodeBlock: return .code(MarkdownFence(info: value.language ?? "", text: value.code))
        case let value as UnorderedList: return .list(MarkdownList(start: nil, items: value.listItems.map(listItem)))
        case let value as OrderedList: return .list(MarkdownList(start: value.startIndex, items: value.listItems.map(listItem)))
        case let value as BlockQuote:
            var children = blocks(value)
            if case .paragraph(let first) = children.first, let paragraph = value.child(at: 0) as? Paragraph, let marker = paragraph.child(at: 0) as? Markdown.Text {
                let hasBreak = paragraph.child(at: 1) is SoftBreak || paragraph.child(at: 1) is LineBreak
                if (hasBreak || paragraph.childCount == 1), let alert = MarkdownAlert.allCases.first(where: { marker.string.trimmingCharacters(in: .whitespaces) == "[!\($0.rawValue)]" }) {
                    let rest = first.droppingFirst(marker.string.count + (hasBreak ? 1 : 0))
                    if rest.fragments.isEmpty { children.removeFirst() } else { children[0] = .paragraph(rest) }
                    return .alert(alert, children)
                }
            }
            return .quote(children)
        case is ThematicBreak: return .rule
        case let value as Table:
            return .table(MarkdownTable(headers: value.head.cells.map { inline($0) }, rows: value.body.rows.map { $0.cells.map { inline($0) } },
                alignments: value.columnAlignments.map { $0 == .right ? .right : $0 == .center ? .center : .left }))
        case let value as HTMLBlock: return .html(value.rawHTML)
        default: return node.childCount > 0 ? .paragraph(inline(node)) : nil
        }
    }
    private static func listItem(_ value: ListItem) -> MarkdownListItem {
        MarkdownListItem(checked: value.checkbox.map { $0 == .checked }, blocks: blocks(value))
    }
    private static func inline(_ node: any Markup, style: MarkdownStyle = [], link: String? = nil) -> MarkdownInline {
        var fragments: [MarkdownFragment] = []
        func walk(_ value: any Markup, _ style: MarkdownStyle, _ link: String?) {
            switch value {
            case let text as Markdown.Text: fragments.append(.text(MarkdownRun(text: text.string, style: style, link: link)))
            case let code as InlineCode: fragments.append(.text(MarkdownRun(text: code.code, style: style.union(.code), link: link)))
            case is SoftBreak: fragments.append(.text(MarkdownRun(text: " ", style: style, link: link)))
            case is LineBreak: fragments.append(.text(MarkdownRun(text: "\n", style: style, link: link)))
            case let image as Markdown.Image: fragments.append(.image(MarkdownImage(source: image.source ?? "", alt: image.plainText, title: image.title, link: link)))
            case let anchor as Markdown.Link: for child in anchor.children { walk(child, style, anchor.destination) }
            case is Strong: for child in value.children { walk(child, style.union(.strong), link) }
            case is Emphasis: for child in value.children { walk(child, style.union(.emphasis), link) }
            case is Strikethrough: for child in value.children { walk(child, style.union(.strike), link) }
            case let html as InlineHTML: fragments.append(.text(MarkdownRun(text: ["<br>", "<br/>", "<br />"].contains(html.rawHTML.lowercased()) ? "\n" : html.rawHTML, style: style, link: link)))
            default: for child in value.children { walk(child, style, link) }
            }
        }
        for child in node.children { walk(child, style, link) }
        let markdown = node.children.map { child -> String in
            if let html = child as? InlineHTML, ["<br>", "<br/>", "<br />"].contains(html.rawHTML.lowercased()) { return "\n" }
            return child.format()
        }.joined()
        return MarkdownInline(fragments: fragments, markdown: markdown)
    }
}
