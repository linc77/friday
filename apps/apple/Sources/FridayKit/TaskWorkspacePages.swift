#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI

struct TaskWorkspacePages<Page: View>: View {
    let pages: [String?]
    let selection: String?
    let context: String
    let select: (String?) -> Void
    @ViewBuilder let page: (String?) -> Page
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let configuration = WorkspacePageConfiguration(pages: pages, selection: selection, context: context,
            animated: !reduceMotion && scenePhase == .active)
        GeometryReader { geometry in
            WorkspacePageSurface(configuration: configuration, size: geometry.size, select: select,
                content: HStack(spacing: 0) {
                    ForEach(configuration.visibleIndices, id: \.self) { index in
                        page(pages[index])
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .allowsHitTesting(index == configuration.index)
                            .accessibilityHidden(index != configuration.index)
                    }
                })
        }
    }
}

struct WorkspacePageConfiguration: Equatable {
    let pages: [String?]
    let selection: String?
    let context: String
    let animated: Bool
    var index: Int { pages.firstIndex(of: selection) ?? 0 }
    var visibleIndices: [Int] { pages.indices.filter { abs($0 - index) <= 1 } }
    var identity: String {
        let data = try? JSONEncoder().encode([Optional(context), selection, animated ? "animated" : "static"] + pages)
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? context
    }
}

private struct WorkspacePageSurface<Content: View>: NSViewRepresentable {
    let configuration: WorkspacePageConfiguration
    let size: CGSize
    let select: (String?) -> Void
    let content: Content

    func makeNSView(context: Context) -> WorkspacePageViewport { WorkspacePageViewport() }
    func updateNSView(_ view: WorkspacePageViewport, context: Context) {
        // A separate hosting root must inherit locale, appearance and Friday's
        // bindings from the surrounding sidebar, rather than use new defaults.
        let root = AnyView(content.environment(\.self, context.environment))
        view.update(configuration, size: size, content: root, select: select)
    }
    static func dismantleNSView(_ view: WorkspacePageViewport, coordinator: ()) { view.stop() }
}

/// The trackpad path mutates only a compositor transform. It does not publish
/// SwiftUI state, lay out lists, or replace the hosting root on scroll samples.
final class WorkspacePageViewport: NSView {
    private let host = NSHostingView(rootView: AnyView(EmptyView()))
    private let gesture = WorkspaceScrollView()
    private var configuration: WorkspacePageConfiguration?
    private var pageSize = CGSize.zero
    private var select: ((String?) -> Void)?
    private var transition = 0
    private var settling = false
    private var dragging = false
    private var awaitingSelection = false
    private var gestureStart: CGFloat = 0
    private(set) var translation: CGFloat = 0
    private static let animationKey = "workspace-page-settle"

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = true
        host.sizingOptions = []
        host.safeAreaRegions = []
        host.wantsLayer = true
        addSubview(host)
        addSubview(gesture)
        gesture.changed = { [weak self] in self?.drag(to: $0) }
        gesture.ended = { [weak self] in self?.end($0, cancelled: $1) }
    }
    convenience init() { self.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var isFlipped: Bool { true }

    func update(_ next: WorkspacePageConfiguration, size: CGSize, content: AnyView, select: @escaping (String?) -> Void) {
        let changed = configuration != next || pageSize != size
        configuration = next; pageSize = size; self.select = select
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if changed { reset(); gesture.updateIdentity(next.identity + "\n\(size.width)x\(size.height)") }
        host.rootView = content
        positionPages()
        // Prepare the adjacent pages before the first drag sample and finish a
        // selection handoff in the same transaction as resetting its transform.
        host.layoutSubtreeIfNeeded()
        CATransaction.commit()
    }

    override func layout() { super.layout(); positionPages() }
    private func positionPages() {
        guard let configuration else { return }
        let first = configuration.visibleIndices.first ?? 0
        let frame = NSRect(x: -CGFloat(configuration.index - first) * pageSize.width, y: 0,
            width: CGFloat(configuration.visibleIndices.count) * pageSize.width, height: pageSize.height)
        if host.frame != frame { host.frame = frame }
        if gesture.frame != bounds { gesture.frame = bounds }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let target = super.hitTest(point) else { return nil }
        if dragging || settling || awaitingSelection { return self }
        return target
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { reset() }
    }

    private func drag(to delta: Double) {
        guard let configuration, !awaitingSelection else { return }
        if settling {
            // Continue from the displayed position when another gesture
            // interrupts a spring, without jumping to its model-layer target.
            let visible = layer?.presentation()?.sublayerTransform.m41 ?? translation
            transition += 1; settling = false
            layer?.removeAnimation(forKey: Self.animationKey)
            gestureStart = visible
        }
        dragging = true
        let total = gestureStart + delta
        let edge = configuration.index == 0 && total > 0 || configuration.index == configuration.pages.count - 1 && total < 0
        let limit = pageSize.width * 0.85
        setTranslation(configuration.animated ? max(-limit, min(limit, total * (edge ? 0.22 : 1))) : 0)
    }

    private func end(_ swipe: WorkspaceSwipe, cancelled: Bool) {
        guard let configuration, !awaitingSelection else { return }
        dragging = false
        var effective = swipe
        if gestureStart != 0 {
            effective = WorkspaceSwipe()
            _ = effective.update(x: gestureStart + swipe.x, y: 0)
        }
        gestureStart = 0
        let destination = effective.destination(index: configuration.index, count: configuration.pages.count, cancelled: cancelled)
        let target = CGFloat(configuration.index - destination) * pageSize.width
        transition += 1
        let token = transition
        guard configuration.animated, abs(translation - target) > 0.5 else {
            setTranslation(target)
            finish(destination, token: token)
            return
        }

        let spring = CASpringAnimation(keyPath: "sublayerTransform.translation.x")
        let frequency = 2 * Double.pi / FridayTheme.motionResponse
        spring.mass = 1
        spring.stiffness = frequency * frequency
        spring.damping = 2 * FridayTheme.motionDamping * frequency
        spring.fromValue = translation
        spring.toValue = target
        spring.duration = FridayTheme.motionResponse
        settling = true
        setTranslation(target)
        layer?.add(spring, forKey: Self.animationKey)
        // The compositor runs the spring independently of SwiftUI. Defer the
        // expensive scope/filter update until that visual transition is over.
        DispatchQueue.main.asyncAfter(deadline: .now() + spring.duration) { [weak self] in
            self?.finish(destination, token: token)
        }
    }

    private func finish(_ destination: Int, token: Int) {
        guard token == transition, let configuration else { return }
        settling = false
        layer?.removeAnimation(forKey: Self.animationKey)
        guard configuration.pages.indices.contains(destination), destination != configuration.index else { return }
        awaitingSelection = true
        select?(configuration.pages[destination])
    }

    private func setTranslation(_ value: CGFloat) {
        translation = value
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer?.sublayerTransform = CATransform3DMakeTranslation(value, 0, 0)
        CATransaction.commit()
    }

    private func reset() {
        transition += 1; settling = false; dragging = false; awaitingSelection = false; gestureStart = 0
        layer?.removeAnimation(forKey: Self.animationKey)
        setTranslation(0)
    }
    func stop() { reset(); gesture.stop() }
}
#endif
