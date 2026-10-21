import SwiftUI

struct MarkdownAnchorID: Hashable { let scope: UUID; let fragment: String }
struct MarkdownFragmentRequest: Equatable { let target: String; let nonce = UUID() }
struct MarkdownNavigation {
    let scope: UUID; let anchors: [String]
    func target(_ href: String) -> MarkdownAnchorID? {
        guard let fragment = Self.fragment(href) else { return nil }
        let normalized = Self.normalized(fragment)
        guard let match = anchors.first(where: { $0 == fragment || Self.normalized($0) == normalized }) else { return nil }
        return MarkdownAnchorID(scope: scope, fragment: match)
    }
    static func fragment(_ href: String) -> String? {
        guard href.hasPrefix("#"), href.count > 1 else { return nil }
        let raw = String(href.dropFirst()); return raw.removingPercentEncoding ?? raw
    }
    private static func normalized(_ fragment: String) -> String {
        var value = fragment
        while value.hasPrefix("user-content-") { value = String(value.dropFirst(13)) }
        return value
    }
    static func anchors(in blocks: [MarkdownBlock]) -> [String] {
        blocks.flatMap { block -> [String] in
            switch block {
            case .paragraph(let inline), .heading(_, let inline): return inline.anchors
            case .list(let list): return list.items.flatMap { anchors(in: $0.blocks) }
            case .quote(let children), .alert(_, let children), .indent(let children): return anchors(in: children)
            case .anchor(let id, let children): return [id] + anchors(in: children)
            case .details(let details): return details.summary.anchors + anchors(in: details.blocks)
            case .table(let table): return (table.headers + table.rows.flatMap { $0 }).flatMap(\.anchors)
            default: return []
            }
        }
    }
}
private struct MarkdownScrollKey: EnvironmentKey { static let defaultValue: ((MarkdownAnchorID) -> Void)? = nil }
private struct MarkdownNavigationKey: EnvironmentKey { static let defaultValue: MarkdownNavigation? = nil }
private struct MarkdownFragmentKey: EnvironmentKey { static let defaultValue: MarkdownFragmentRequest? = nil }
extension EnvironmentValues {
    var markdownScrollTo: ((MarkdownAnchorID) -> Void)? { get { self[MarkdownScrollKey.self] } set { self[MarkdownScrollKey.self] = newValue } }
    var markdownNavigation: MarkdownNavigation? { get { self[MarkdownNavigationKey.self] } set { self[MarkdownNavigationKey.self] = newValue } }
    var markdownFragmentRequest: MarkdownFragmentRequest? { get { self[MarkdownFragmentKey.self] } set { self[MarkdownFragmentKey.self] = newValue } }
}
struct MarkdownAnchors: ViewModifier {
    let ids: [String]
    @Environment(\.markdownNavigation) private var navigation
    func body(content: Content) -> some View {
        content.background(alignment: .topLeading) {
            if let navigation {
                ForEach(Array(ids.enumerated()), id: \.offset) { _, id in
                    Color.clear.frame(width: 1, height: 1).id(MarkdownAnchorID(scope: navigation.scope, fragment: id)).accessibilityHidden(true)
                }
            }
        }
    }
}
