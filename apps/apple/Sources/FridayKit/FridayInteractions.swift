import SwiftUI
#if os(macOS)
import AppKit
#endif

extension View {
    /// Apply to the control's complete hit area, inside any `.disabled` modifier.
    public func fridayInteractiveCursor() -> some View {
        modifier(FridayInteractiveCursor())
    }

    /// Use for fixed controls outside replaceable native content hosts.
    func fridayInteractiveCursor(nativeRegion: Bool) -> some View {
        modifier(FridayInteractiveCursor(nativeRegion: nativeRegion))
    }
}

private struct FridayInteractiveCursor: ViewModifier {
    var nativeRegion = false
    @Environment(\.isEnabled) private var isEnabled

    @ViewBuilder func body(content: Content) -> some View {
        #if os(macOS)
        if #available(macOS 15.0, *), !nativeRegion {
            content.pointerStyle(isEnabled ? .link : nil)
        } else {
            // The fixed navigation rail outlives its native module hosts.
            // Register it in AppKit's cursor-rectangle lifecycle so a stationary
            // pointer does not depend on another SwiftUI hover update.
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

/// AppKit owns cursor lifetime, including scrolling and view removal. Keep this
/// region attached to the control rather than restoring a global cursor on hover.
private struct FridayCursorRegion: NSViewRepresentable {
    let enabled: Bool

    func makeNSView(context: Context) -> FridayCursorView { FridayCursorView() }

    func updateNSView(_ view: FridayCursorView, context: Context) {
        view.enabled = enabled
    }
}

private final class FridayCursorView: NSView {
    var enabled = true {
        didSet {
            guard enabled != oldValue else { return }
            window?.invalidateCursorRects(for: self)
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func resetCursorRects() {
        super.resetCursorRects()
        if enabled, !visibleRect.isEmpty { addCursorRect(visibleRect, cursor: .pointingHand) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.invalidateCursorRects(for: self)
    }
}
#endif
