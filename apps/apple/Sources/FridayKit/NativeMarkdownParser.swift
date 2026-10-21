import Foundation
import JavaScriptCore

/// The same CommonMark → GFM → HTML → sanitized HAST stages used by T3code.
/// Only data crosses this boundary; HTML never runs in a window or WebView.
final class NativeMarkdownParser: @unchecked Sendable {
    static let shared = NativeMarkdownParser()
    private let lock = NSLock()
    private var context: JSContext?
    private var unavailable = false

    func parse(_ source: String) -> [MarkdownBlock]? {
        guard !Task.isCancelled, source.utf8.count <= 1_048_576 else { return nil }
        lock.lock(); defer { lock.unlock() }
        guard !Task.isCancelled, let context = runtime() else { return nil }
        context.exception = nil
        let result = context.objectForKeyedSubscript("fridayParseMarkdown")?.call(withArguments: [source])
        guard context.exception == nil, let json = result?.toString(), json.utf8.count <= 16 * 1_048_576,
              let root = try? JSONDecoder().decode(MarkdownHast.self, from: Data(json.utf8)) else { return nil }
        return MarkdownHast.blocks(root.nodes)
    }
    private func runtime() -> JSContext? {
        if let context { return context }; if unavailable { return nil }; unavailable = true
        guard let url = Bundle.module.url(forResource: "MarkdownParser", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8), let value = JSContext() else { return nil }
        value.evaluateScript(source)
        guard value.exception == nil, value.objectForKeyedSubscript("fridayParseMarkdown")?.isUndefined == false else { return nil }
        context = value; return value
    }
}

private struct MarkdownHast: Decodable {
    struct Properties: Decodable {
        let id: String?; let href: String?; let src: String?; let alt: String?; let dataMarkdownTitle: String?
        let className: [String]?; let dataCodeMeta: String?; let dataAlert: String?
        let checked: Bool?; let start: Int?; let open: Bool?; let align: String?
        let dataFridayImageID: String?
        let dataFridayTaskMarker: Int?
        let width: MarkdownMediaDimension?; let height: MarkdownMediaDimension?
    }
    let type: String; let tagName: String?; let value: String?; let properties: Properties?; let children: [Self]?
    var nodes: [Self] { children ?? [] }
    private static let blockTags: Set<String> = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "ul", "ol", "li", "blockquote", "hr", "table", "details", "div", "section", "dl", "dt", "dd"]

    static func blocks(_ nodes: [Self]) -> [MarkdownBlock] {
        var result: [MarkdownBlock] = [], pending: [Self] = []
        func flush() {
            // Formatting whitespace between root HTML blocks is not its own text row.
            while pending.first.map({ $0.type == "text" && ($0.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) == true { pending.removeFirst() }
            while pending.last.map({ $0.type == "text" && ($0.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) == true { pending.removeLast() }
            let value = inline(pending)
            if !value.plainText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || value.fragments.contains(where: { if case .image = $0 { true } else { false } }) || !value.anchors.isEmpty { result.append(.paragraph(value)) }
            pending = []
        }
        for node in nodes {
            if let tag = node.tagName, blockTags.contains(tag) { flush(); result += block(node) }
            else { pending.append(node) }
        }
        flush(); return result
    }
    private static func block(_ node: Self) -> [MarkdownBlock] {
        let children = node.nodes, tag = node.tagName ?? ""
        var result: [MarkdownBlock]
        switch tag {
        case "p": result = [.paragraph(inline(children))]
        case "h1", "h2", "h3", "h4", "h5", "h6":
            if node.properties?.className?.contains("sr-only") == true { return node.properties?.id.map { [.anchor($0, [])] } ?? [] }
            var text = inline(children); if let id = node.properties?.id { text.anchors.insert(id, at: 0) }
            return [.heading(Int(tag.dropFirst()) ?? 1, text)]
        case "pre":
            let code = children.first { $0.tagName == "code" } ?? node
            let language = code.properties?.className?.first { $0.hasPrefix("language-") }.map { String($0.dropFirst(9)) } ?? "text"
            result = [.code(MarkdownFence(info: language + " " + (code.properties?.dataCodeMeta ?? ""), text: code.plainText))]
        case "ul", "ol":
            let items = children.filter { $0.tagName == "li" }.map { item -> MarkdownListItem in
                var checked: Bool?
                func removingCheckbox(_ value: Self) -> Self? {
                    if value.tagName == "ul" || value.tagName == "ol" { return value }
                    if value.tagName == "input" { checked = value.properties?.checked ?? false; return nil }
                    return Self(type: value.type, tagName: value.tagName, value: value.value, properties: value.properties, children: value.children.map { $0.compactMap(removingCheckbox) })
                }
                let content = item.nodes.compactMap(removingCheckbox)
                var body = blocks(content)
                if checked != nil, case .paragraph(var first) = body.first, case .text(var run) = first.fragments.first, run.text.hasPrefix(" ") {
                    run.text.removeFirst(); first.fragments[0] = .text(run); body[0] = .paragraph(first)
                }
                if let id = item.properties?.id { body = [.anchor(id, body)] }
                return MarkdownListItem(checked: checked, blocks: body, markerOffset: item.properties?.dataFridayTaskMarker)
            }
            result = [.list(MarkdownList(start: tag == "ol" ? UInt(max(0, node.properties?.start ?? 1)) : nil, items: items))]
        case "blockquote":
            let content = blocks(children)
            if let raw = node.properties?.dataAlert, let kind = MarkdownAlert(rawValue: raw.uppercased()) { result = [.alert(kind, content)] }
            else { result = [.quote(content)] }
        case "hr": result = [.rule]
        case "details":
            let index = children.firstIndex { $0.tagName == "summary" }
            let summary = index.map { inline(children[$0].nodes) }
            result = [.details(MarkdownDetails(summary: summary ?? .text(""), initiallyOpen: node.properties?.open == true, blocks: blocks(children.enumerated().filter { $0.offset != index }.map(\.element))))]
        case "table": result = table(node).map { [.table($0)] } ?? []
        case "dd": result = [.indent(blocks(children))]
        case "dt": result = [.paragraph(inline(children, style: .strong))]
        default: result = blocks(children)
        }
        if let id = node.properties?.id { return [.anchor(id, result)] }
        return result
    }
    private static func table(_ node: Self) -> MarkdownTable? {
        func rows(_ node: Self) -> [Self] {
            node.tagName == "tr" ? [node] : node.nodes.filter { ["thead", "tbody", "tfoot", "tr"].contains($0.tagName ?? "") }.flatMap(rows)
        }
        let raw = rows(node).map { $0.nodes.filter { $0.tagName == "th" || $0.tagName == "td" } }
        guard let first = raw.first, !first.isEmpty else { return nil }
        let count = raw.map(\.count).max() ?? first.count
        func cells(_ row: [Self]) -> [MarkdownInline] { row.map { inline($0.nodes) } + Array(repeating: .text(""), count: max(0, count - row.count)) }
        let alignment = (0..<count).map { index -> MarkdownAlignment in
            guard index < first.count else { return .left }; return MarkdownAlignment(rawValue: first[index].properties?.align ?? "") ?? .left
        }
        return MarkdownTable(headers: cells(first), rows: raw.dropFirst().map(cells), alignments: alignment, headerIsStyled: first.contains { $0.tagName == "th" })
    }
    private var plainText: String { value ?? nodes.map(\.plainText).joined() }
    private static func inline(_ nodes: [Self], style: MarkdownStyle = [], link: String? = nil) -> MarkdownInline {
        var fragments: [MarkdownFragment] = [], anchors: [String] = []
        func append(_ node: Self, style: MarkdownStyle, link: String?) {
            if let id = node.properties?.id { anchors.append(id) }
            if node.type == "text", let value = node.value {
                let text = style.contains(.code) ? value : value.replacingOccurrences(of: #"[\t\n\r\f ]+"#, with: " ", options: .regularExpression)
                if !text.isEmpty { fragments.append(.text(MarkdownRun(text: text, style: style, link: link))) }; return
            }
            let tag = node.tagName ?? ""
            if tag == "br" { fragments.append(.text(MarkdownRun(text: "\n", style: style, link: link))); return }
            if tag == "img" {
                fragments.append(.image(MarkdownImage(source: node.properties?.src ?? "", alt: node.properties?.alt ?? "", title: node.properties?.dataMarkdownTitle, link: link, galleryID: node.properties?.dataFridayImageID, width: node.properties?.width?.value, height: node.properties?.height?.value))); return
            }
            var next = style
            switch tag {
            case "b", "strong": next.insert(.strong)
            case "i", "em", "var": next.insert(.emphasis)
            case "del", "s", "strike": next.insert(.strike)
            case "code", "samp", "tt": next.insert(.code)
            case "kbd": next.insert(.keyboard)
            case "ins": next.insert(.underline)
            case "sub": next.insert(.subscriptText)
            case "sup": next.insert(.superscriptText)
            default: break
            }
            for child in node.nodes { append(child, style: next, link: tag == "a" ? node.properties?.href : link) }
        }
        for node in nodes { append(node, style: style, link: link) }
        return MarkdownInline(fragments: fragments, markdown: nodes.map(markdown).joined(), anchors: anchors)
    }
    private static func markdown(_ node: Self) -> String {
        if let value = node.value { return value.replacingOccurrences(of: #"[\t\n\r\f ]+"#, with: " ", options: .regularExpression) }
        let text = node.nodes.map(markdown).joined()
        switch node.tagName {
        case "strong", "b": return "**\(text)**"
        case "em", "i": return "*\(text)*"
        case "del", "s", "strike": return "~~\(text)~~"
        case "code":
            let raw = node.plainText
            let longest = raw.split(whereSeparator: { $0 != "`" }).map(\.count).max() ?? 0
            let delimiter = String(repeating: "`", count: longest + 1)
            let content = raw.hasPrefix("`") || raw.hasSuffix("`") ? " " + raw + " " : raw
            return delimiter + content + delimiter
        case "a": return node.properties?.href.map { "[\(text)](\($0))" } ?? text
        case "img": return "![\(node.properties?.alt ?? "")](\(node.properties?.src ?? ""))"
        case "br": return "\n"
        default: return text
        }
    }
}
