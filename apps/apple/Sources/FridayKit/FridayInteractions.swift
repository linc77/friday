import SwiftUI
#if os(macOS)
import AppKit
#endif

extension View {
    /// Apply to the control's complete hit area, inside any `.disabled` modifier.
    func fridayInteractiveCursor() -> some View {
        modifier(FridayInteractiveCursor())
    }
}

private struct FridayInteractiveCursor: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled

    @ViewBuilder func body(content: Content) -> some View {
        #if os(macOS)
        if #available(macOS 15.0, *) {
            content.pointerStyle(isEnabled ? .link : nil)
        } else {
            content.background(FridayCursorRegion(enabled: isEnabled))
        }
        #else
        content
        #endif
    }
}

#if os(macOS)
/// Preserve automatic native button behavior and appearance for unstyled controls.
struct FridayDefaultButtonStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button(configuration)
            .buttonStyle(.automatic)
            .fridayInteractiveCursor()
    }
}

/// AppKit owns cursor lifetime on macOS 14, including scrolling and view removal.
private struct FridayCursorRegion: NSViewRepresentable {
    let enabled: Bool

    func makeNSView(context: Context) -> FridayCursorView { FridayCursorView() }

    func updateNSView(_ view: FridayCursorView, context: Context) {
        view.enabled = enabled
        view.window?.invalidateCursorRects(for: view)
    }
}

private final class FridayCursorView: NSView {
    var enabled = true

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func resetCursorRects() {
        super.resetCursorRects()
        if enabled { addCursorRect(visibleRect, cursor: .pointingHand) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.invalidateCursorRects(for: self)
    }
}
#endif
