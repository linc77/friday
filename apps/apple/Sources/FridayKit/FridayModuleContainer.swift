#if os(macOS)
import AppKit
import SwiftUI

/// Retain each visited module's SwiftUI graph, but attach only the selected
/// graph to the window. Detaching pauses rendering and view-scoped tasks while
/// preserving local editing/scroll state for the next visit.
struct FridayRetainedPages<Key: Hashable, Content: View>: NSViewRepresentable {
    let selection: Key
    let scope: String
    var capacity = 6
    var validKeys: Set<Key>? = nil
    var presentationID: String? = nil
    @ViewBuilder let content: () -> Content

    func makeNSView(context: Context) -> FridayRetainedViewport<Key> { FridayRetainedViewport() }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: FridayRetainedViewport<Key>, context: Context) -> CGSize? {
        FridayViewportSizing.size(proposal, current: nsView.bounds.size)
    }

    func updateNSView(_ view: FridayRetainedViewport<Key>, context: Context) {
        view.update(selection: selection, scope: scope,
                    content: AnyView(content().environment(\.self, context.environment)),
                    capacity: capacity, validKeys: validKeys, presentationID: presentationID)
    }

    static func dismantleNSView(_ view: FridayRetainedViewport<Key>, coordinator: ()) { view.reset() }
}

typealias FridayModuleContainer<Content: View> = FridayRetainedPages<FridaySection, Content>
typealias FridayModuleViewport = FridayRetainedViewport<FridaySection>

/// These containers fill a viewport; their documents do not determine its size.
/// Letting the representable fall back to AppKit fittingSize walks and solves
/// the entire nested hosting tree on every resize proposal.
enum FridayViewportSizing {
    static func size(_ proposal: ProposedViewSize, current: CGSize) -> CGSize {
        func dimension(_ proposed: CGFloat?, _ existing: CGFloat) -> CGFloat {
            if let proposed, proposed.isFinite { return max(0, proposed) }
            return existing.isFinite ? max(0, existing) : 0
        }
        return CGSize(width: dimension(proposal.width, current.width), height: dimension(proposal.height, current.height))
    }
}

final class FridayRetainedViewport<Key: Hashable>: NSView {
    private var hosts: [Key: FridayPageHostingView] = [:]
    private var recent: [Key] = []
    private var selection: Key?
    private var scope: String?

    override var isFlipped: Bool { true }

    func update(selection next: Key, scope: String, content: AnyView,
                capacity: Int = 6, validKeys: Set<Key>? = nil, presentationID: String? = nil) {
        if self.scope != scope { reset(); self.scope = scope }
        if selection != next, let previous = selection.flatMap({ hosts[$0] }) {
            if let responder = window?.firstResponder as? NSView, responder.isDescendant(of: previous) {
                window?.makeFirstResponder(nil)
            }
            previous.removeFromSuperview()
        }
        selection = next
        let host: FridayPageHostingView
        if let existing = hosts[next] {
            host = existing
            host.rootView = content
        } else {
            host = FridayPageHostingView(rootView: content)
            host.sizingOptions = []
            host.safeAreaRegions = []
            host.autoresizingMask = [.width, .height]
            hosts[next] = host
        }
        host.presentationID = presentationID
        if host.frame != bounds { host.frame = bounds }
        if host.superview == nil { addSubview(host) }
        if recent.last != next { recent.removeAll { $0 == next }; recent.append(next) }
        // Keep a small working set. Deleted tasks and least recently visited
        // pages release their view graphs, editors and parsed message bodies.
        if let validKeys {
            for key in Array(hosts.keys) where key != next && !validKeys.contains(key) { remove(key) }
        }
        while hosts.count > max(1, capacity), let oldest = recent.first(where: { $0 != next }) { remove(oldest) }
    }

    override func layout() {
        super.layout()
        if let selection, let host = hosts[selection], host.frame != bounds { host.frame = bounds }
    }

    private func remove(_ key: Key) {
        hosts.removeValue(forKey: key)?.removeFromSuperview()
        recent.removeAll { $0 == key }
    }

    func reset() {
        if let active = selection.flatMap({ hosts[$0] }),
           let responder = window?.firstResponder as? NSView, responder.isDescendant(of: active) {
            window?.makeFirstResponder(nil)
        }
        for host in hosts.values { host.removeFromSuperview() }
        hosts.removeAll()
        recent.removeAll()
        selection = nil
        scope = nil
    }
}

private final class FridayPageHostingView: NSHostingView<AnyView> {
    var presentationID: String?
    override func layout() {
        super.layout()
        TaskPresentationTiming.didLayout(presentationID)
    }
}
#endif
