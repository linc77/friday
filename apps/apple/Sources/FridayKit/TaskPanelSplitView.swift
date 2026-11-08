#if os(macOS)
import AppKit
import SwiftUI

/// Pointer motion changes native frames only. The owning SwiftUI page receives
/// one committed width when the gesture ends, so persistence and transcript
/// derivation never run for every pointer sample.
struct TaskPanelSplitView<Main: View, Panel: View>: NSViewRepresentable {
    @Binding var width: Double
    let visible: Bool
    var panelOnLeadingEdge = false
    let main: Main
    let panel: () -> Panel

    func makeNSView(context: Context) -> TaskPanelSplitHost { TaskPanelSplitHost() }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: TaskPanelSplitHost, context: Context) -> CGSize? {
        FridayViewportSizing.size(proposal, current: nsView.bounds.size)
    }
    func updateNSView(_ view: TaskPanelSplitHost, context: Context) {
        view.update(width: width, visible: visible, panelOnLeadingEdge: panelOnLeadingEdge,
                    main: AnyView(main.environment(\.self, context.environment)),
                    panel: visible ? AnyView(panel().environment(\.self, context.environment)) : AnyView(EmptyView()),
                    commit: { width = $0 })
    }
}

@MainActor final class TaskPanelSplitHost: NSView {
    private let mainHost = FridayPaneHostingView(rootView: AnyView(EmptyView()))
    private let panelHost = FridayPaneHostingView(rootView: AnyView(EmptyView()))
    private let divider = TaskPanelDivider()
    private var panelOnLeadingEdge = false
    private var visible = false
    private var preferredWidth: CGFloat = 460
    private var dragStart: (x: CGFloat, width: CGFloat)?
    private var dragRootUpdates = 0
    private var dragLayouts = 0
    private var commit: (Double) -> Void = { _ in }
    private(set) var displayedWidth: CGFloat = 460
    private static var dividerWidth: CGFloat { FridayTheme.paneSpacing }
    override var isFlipped: Bool { true }

    init() {
        super.init(frame: .zero)
        for host in [mainHost, panelHost] { host.sizingOptions = []; host.safeAreaRegions = [] }
        addSubview(mainHost)
        divider.owner = self
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(width: Double, visible: Bool, panelOnLeadingEdge: Bool = false, main: AnyView, panel: AnyView, commit: @escaping (Double) -> Void) {
        if dragStart != nil { dragRootUpdates += 1 }
        self.panelOnLeadingEdge = panelOnLeadingEdge
        self.commit = commit
        preferredWidth = width.isFinite ? width : 460
        if !visible { dragStart = nil }
        self.visible = visible
        mainHost.rootView = main
        if visible {
            panelHost.rootView = panel
            if panelHost.superview == nil { addSubview(panelHost); addSubview(divider) }
        } else { panelHost.removeFromSuperview(); divider.removeFromSuperview() }
        if dragStart == nil { displayedWidth = preferredWidth }
        needsLayout = true
    }

    static func clamped(_ width: CGFloat, total: CGFloat) -> CGFloat {
        let usable = max(0, total - dividerWidth)
        let lower = min(320, usable / 2), upper = max(lower, usable - min(380, usable / 2))
        return min(upper, max(lower, width.isFinite ? width : 460))
    }
    private func clampedWidth(_ width: CGFloat) -> CGFloat {
        guard panelOnLeadingEdge else { return Self.clamped(width, total: bounds.width) }
        let usable = max(0, bounds.width - Self.dividerWidth)
        let lower = min(200, usable / 2)
        let upper = max(lower, min(480, usable - min(420, usable / 2)))
        return min(upper, max(lower, width.isFinite ? width : 250))
    }

    override func layout() {
        super.layout()
        if dragStart != nil { dragLayouts += 1 }
        guard visible else { setFrame(mainHost, bounds); return }
        displayedWidth = clampedWidth(dragStart == nil ? preferredWidth : displayedWidth)
        let mainWidth = max(0, bounds.width - displayedWidth - Self.dividerWidth)
        let dividerX = panelOnLeadingEdge ? displayedWidth : mainWidth
        setFrame(mainHost, NSRect(x: panelOnLeadingEdge ? displayedWidth + Self.dividerWidth : 0, y: 0, width: mainWidth, height: bounds.height))
        setFrame(divider, NSRect(x: dividerX, y: 0, width: Self.dividerWidth, height: bounds.height))
        setFrame(panelHost, NSRect(x: panelOnLeadingEdge ? 0 : mainWidth + Self.dividerWidth, y: 0, width: displayedWidth, height: bounds.height))
    }
    private func setFrame(_ view: NSView, _ frame: NSRect) {
        guard view.frame != frame else { return }
        let exposed = view.frame.union(frame)
        view.frame = frame
        // AppKit frame setters do not invalidate drawing. Moving a transparent
        // hosting surface without damage notification preserves old edge pixels.
        view.needsDisplay = true
        setNeedsDisplay(exposed)
    }

    func beginResize(at x: CGFloat) {
        dragStart = (x, displayedWidth); dragRootUpdates = 0; dragLayouts = 0
    }
    func resize(to x: CGFloat) {
        guard let start = dragStart else { return }
        displayedWidth = clampedWidth(start.width + (panelOnLeadingEdge ? x - start.x : start.x - x))
        needsLayout = true
    }
    func finishResize(cancelled: Bool = false) {
        guard dragStart != nil else { return }
        TaskPresentationTiming.resized(rootUpdates: dragRootUpdates, layouts: dragLayouts)
        dragStart = nil
        if cancelled { displayedWidth = preferredWidth }
        else if preferredWidth != displayedWidth { preferredWidth = displayedWidth; commit(Double(displayedWidth)) }
        needsLayout = true
    }
    func adjust(by delta: CGFloat) {
        beginResize(at: 0); resize(to: panelOnLeadingEdge ? delta : -delta); finishResize()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { finishResize(cancelled: true) }
    }
}

@MainActor private final class TaskPanelDivider: NSView {
    weak var owner: TaskPanelSplitHost?
    override var acceptsFirstResponder: Bool { true }
    // Transparent gutters are controls, not draggable window background.
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.splitter)
        setAccessibilityLabel(String(localized: "调整侧栏宽度", bundle: .module))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    // Keep main's transparent pane gutter; this view only owns its hit area.
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    override func mouseDown(with event: NSEvent) { owner?.beginResize(at: owner?.convert(event.locationInWindow, from: nil).x ?? 0) }
    override func mouseDragged(with event: NSEvent) { owner?.resize(to: owner?.convert(event.locationInWindow, from: nil).x ?? 0) }
    override func mouseUp(with event: NSEvent) { owner?.finishResize() }
    override func accessibilityPerformIncrement() -> Bool { owner?.adjust(by: 40); return owner != nil }
    override func accessibilityPerformDecrement() -> Bool { owner?.adjust(by: -40); return owner != nil }
    private func moveDivider(by delta: CGFloat) {
        owner?.beginResize(at: 0)
        owner?.resize(to: delta)
        owner?.finishResize()
    }
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 123: moveDivider(by: -40)
        case 124: moveDivider(by: 40)
        case 53: owner?.finishResize(cancelled: true)
        default: super.keyDown(with: event)
        }
    }
}
#endif
