#if os(macOS)
import AppKit
import SwiftUI

/// An explicit drag target for the top gutter of the borderless main window.
struct FridayWindowDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> FridayWindowDragView { FridayWindowDragView() }
    func updateNSView(_ view: FridayWindowDragView, context: Context) {}
}

final class FridayWindowDragView: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let window, !window.styleMask.contains(.fullScreen) else { return }
        window.performDrag(with: event)
    }
}

/// AppKit's standard controls, hosted in the rail of the plain main window.
struct FridayWindowControls: NSViewRepresentable {
    func makeNSView(context: Context) -> FridayWindowControlsView { FridayWindowControlsView() }
    func updateNSView(_ view: FridayWindowControlsView, context: Context) { view.updateWindow() }
}

final class FridayWindowControlsView: NSView {
    private let buttons: [NSButton] = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton]
        .compactMap { NSWindow.standardWindowButton($0, for: [.titled, .closable, .miniaturizable, .resizable]) }
    override var isFlipped: Bool { true }

    init() {
        super.init(frame: .zero)
        for button in buttons { addSubview(button) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if let window { NotificationCenter.default.removeObserver(self, name: nil, object: window) }
        super.viewWillMove(toWindow: newWindow)
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window else { return }
        for name in [NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification,
                     NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification, NSWindow.didResizeNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(updateWindow), name: name, object: window)
        }
        updateWindow()
    }
    @objc func updateWindow() {
        guard let window else { return }
        for button in buttons {
            // The factory supplies the standard actions; AppKit owns their behavior.
            button.target = window
            button.isHidden = window.styleMask.contains(.fullScreen)
            button.needsDisplay = true
        }
        window.invalidateCursorRects(for: self)
    }
    override func layout() {
        super.layout()
        let size = FridayTheme.trafficLightSize
        let width = size * CGFloat(buttons.count) + FridayTheme.trafficLightSpacing * CGFloat(max(0, buttons.count - 1))
        var x = (bounds.width - width) / 2
        for button in buttons {
            button.frame = NSRect(x: x, y: 8, width: size, height: size)
            button.bounds = NSRect(x: 0, y: 0, width: 14, height: 14)
            x += size + FridayTheme.trafficLightSpacing
        }
    }
    override func resetCursorRects() {
        super.resetCursorRects()
        for button in buttons where !button.isHidden && button.isEnabled { addCursorRect(button.frame, cursor: .pointingHand) }
    }
    override func mouseDown(with event: NSEvent) {
        // Empty space around the controls remains a native window drag handle.
        window?.performDrag(with: event)
    }
}
#endif
