import Foundation

struct MermaidDiagram: Equatable, Sendable {
    let svg: String; let width: Double; let height: Double
    init?(svg: String, width: Double, height: Double) {
        guard svg.utf8.count <= 8 * 1024 * 1024, svg.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("<svg"),
              width.isFinite, height.isFinite, width > 0, height > 0, width <= 100_000, height <= 100_000 else { return nil }
        self.svg = svg; self.width = width; self.height = height
    }
    func displayHeight(availableWidth: Double) -> Double { ceil(height * min(1, max(1, availableWidth) / width)) }
}
enum MermaidResult: Equatable, Sendable {
    case rendered(MermaidDiagram)
    case failure(String, retryable: Bool)
}
struct MermaidRequest: Hashable, Sendable {
    let source: String; let dark: Bool
    init(source: String, dark: Bool) { self.source = source.trimmingCharacters(in: .whitespacesAndNewlines); self.dark = dark }
}
struct MermaidRenderCache {
    private var values: [MermaidRequest: MermaidResult] = [:]
    private var order: [MermaidRequest] = []
    mutating func read(_ key: MermaidRequest) -> MermaidResult? {
        guard let value = values[key] else { return nil }; order.removeAll { $0 == key }; order.append(key); return value
    }
    mutating func store(_ key: MermaidRequest, result: MermaidResult) {
        order.removeAll { $0 == key }; order.append(key); values[key] = result
        while order.count > 64 { values.removeValue(forKey: order.removeFirst()) }
    }
    mutating func remove(_ key: MermaidRequest) { values.removeValue(forKey: key); order.removeAll { $0 == key } }
}
struct MermaidWorkerMessage: Decodable {
    let type: String
    var id: String? = nil; var svg: String? = nil; var width: Double? = nil; var height: Double? = nil
    var message: String? = nil; var retryable: Bool? = nil
    var diagram: MermaidDiagram? {
        guard type == "rendered", let svg, let width, let height else { return nil }; return MermaidDiagram(svg: svg, width: width, height: height)
    }
}
enum MermaidWebPolicy {
    static let networkRules = #"[{"trigger":{"url-filter":"^[a-zA-Z][a-zA-Z0-9+.-]*://","url-filter-is-case-sensitive":false},"action":{"type":"block"}}]"#
    static func navigationAllowed(_ url: URL?) -> Bool { url?.absoluteString == "about:blank" }
    static let workerHTML = #"""
    <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src blob: data:; base-uri 'none'; form-action 'none'">
    <style>html,body{margin:0;background:transparent;font:14px -apple-system,BlinkMacSystemFont,sans-serif}</style></head><body></body></html>
    """#
    static func svgHTML(_ diagram: MermaidDiagram, expanded: Bool, embeddedImages: Bool = false) -> String {
        let height = expanded ? "max-height:calc(100vh - 16px);" : ""
        let images = embeddedImages ? "img-src data:;" : ""
        return #"""
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=yes">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; \#(images) base-uri 'none'; form-action 'none'">
        <style>html,body{margin:0;background:transparent}body{display:flex;align-items:center;justify-content:center;min-height:100vh}svg{display:block;width:100%!important;max-width:\#(diagram.width)px!important;height:auto!important;\#(height)}</style></head><body>\#(diagram.svg)</body></html>
        """#
    }
}
