import SwiftUI
#if os(macOS)
import AppKit
#endif

extension View {
    /// Only for the padded, focusable text-entry area, never its toolbar.
    @ViewBuilder func fridayTextEntryCursor() -> some View {
        #if os(macOS)
        if #available(macOS 15.0, *) {
            pointerStyle(.horizontalText)
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// Apply to the control's complete hit area, inside any `.disabled` modifier.
    public func fridayInteractiveCursor() -> some View {
        modifier(FridayInteractiveCursor())
    }

    /// Keep the expanded content's text and controls outside the header cursor.
    @ViewBuilder func fridayDisclosureCursor() -> some View {
        #if os(macOS)
        disclosureGroupStyle(FridayDisclosureStyle())
        #else
        self
        #endif
    }

}

private struct FridayInteractiveCursor: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled

    @ViewBuilder func body(content: Content) -> some View {
        #if os(macOS)
        if #available(macOS 15.0, *) {
            // SwiftUI owns the cursor for its controls. Do not compete with its
            // cursor updates using an AppKit overlay or mouse-move callbacks.
            content.pointerStyle(isEnabled ? .link : nil)
        } else {
            content.background(FridayLegacyCursorRegion(enabled: isEnabled))
        }
        #else
        content
        #endif
    }
}

#if os(macOS)
private struct FridayDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { configuration.isExpanded.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .medium))
                        .accessibilityHidden(true)
                    configuration.label
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .fridayInteractiveCursor()
            .accessibilityValue(Text(friday: configuration.isExpanded ? "已展开" : "已收起"))
            if configuration.isExpanded {
                configuration.content.padding(.leading, 16)
            }
        }
    }
}

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
struct FridayLegacyCursorRegion: NSViewRepresentable {
    let enabled: Bool

    func makeNSView(context: Context) -> FridayLegacyCursorView { FridayLegacyCursorView() }

    func updateNSView(_ view: FridayLegacyCursorView, context: Context) {
        view.enabled = enabled
    }
}

final class FridayLegacyCursorView: NSView {
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
