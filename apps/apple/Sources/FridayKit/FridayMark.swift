import SwiftUI
#if os(macOS)
import AppKit
#endif

/// The conversation avatar has its own expression; it is not a status spinner.
/// Only the newest assistant message opts into motion and pointer observation.
struct FridayMark: View {
    var size: CGFloat = 40
    var interactive = false
    @State private var gaze = CGPoint.zero
    @State private var eyesClosed = false
    @State private var visible = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var animates: Bool { interactive && visible && !reduceMotion && scenePhase == .active }

    var body: some View {
        ZStack {
            Ellipse()
                .fill(.black.opacity(0.10))
                .frame(width: size * 0.55, height: size * 0.08)
                .blur(radius: size * 0.045)
                .offset(y: size * 0.44)

            Circle()
                .fill(RadialGradient(stops: [
                    .init(color: Color(red: 0.24, green: 0.40, blue: 1), location: 0),
                    .init(color: Color(red: 0.12, green: 0.28, blue: 0.94), location: 0.58),
                    .init(color: Color(red: 0.04, green: 0.16, blue: 0.72), location: 1),
                ], center: UnitPoint(x: 0.3, y: 0.22), startRadius: 0, endRadius: size * 0.87))
                .overlay {
                    Circle().fill(RadialGradient(colors: [.white.opacity(0.13), .clear],
                        center: UnitPoint(x: 0.29, y: 0.17), startRadius: 0, endRadius: size * 0.48))
                }
                .frame(width: size * 0.90, height: size * 0.90)
                .offset(y: -size * 0.025)

            HStack(spacing: size * 0.105) {
                eye
                eye
            }
            .rotationEffect(.degrees(Double(gaze.x) * 3))
            .offset(x: gaze.x * size * 0.065, y: -size * 0.09 + gaze.y * size * 0.045)

            FridayBowTie()
                .fill(LinearGradient(colors: [Color(white: 0.16), Color(white: 0.055)], startPoint: .top, endPoint: .bottom))
                .frame(width: size * 0.46, height: size * 0.18)
                .overlay {
                    RoundedRectangle(cornerRadius: size * 0.025)
                        .fill(Color(white: 0.10))
                        .frame(width: size * 0.085, height: size * 0.115)
                }
                .rotationEffect(.degrees(Double(gaze.x) * 1.5))
                .offset(y: size * 0.365)
        }
        .frame(width: size, height: size)
        .background {
            #if os(macOS)
            if animates { FridayAvatarPointer { point in
                guard gaze != point else { return }
                withAnimation(.easeOut(duration: 0.12)) { gaze = point }
            } }
            #endif
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .onChange(of: animates) { _, enabled in
            if !enabled {
                var transaction = Transaction(); transaction.disablesAnimations = true
                withTransaction(transaction) { gaze = .zero; eyesClosed = false }
            }
        }
        .task(id: animates) {
            guard animates else { return }
            do {
                while !Task.isCancelled {
                    try await Task.sleep(for: .seconds(4.8))
                    withAnimation(.easeIn(duration: 0.08)) { eyesClosed = true }
                    try await Task.sleep(for: .milliseconds(140))
                    withAnimation(.easeOut(duration: 0.12)) { eyesClosed = false }
                }
            } catch { /* Leaving the page or backgrounding stops the expression. */ }
        }
    }

    private var eye: some View {
        Capsule()
            .fill(Color(red: 0.035, green: 0.055, blue: 0.105))
            .frame(width: size * 0.075, height: size * 0.135)
            .scaleEffect(x: 1, y: eyesClosed ? 0.15 : 1)
    }
}

private struct FridayBowTie: Shape {
    func path(in rect: CGRect) -> Path {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height)
        }
        var path = Path()
        path.move(to: point(0.48, 0.40))
        path.addCurve(to: point(0.10, 0.06), control1: point(0.31, 0.19), control2: point(0.15, 0.01))
        path.addQuadCurve(to: point(0.02, 0.20), control: point(0.02, 0.04))
        path.addLine(to: point(0.02, 0.80))
        path.addQuadCurve(to: point(0.10, 0.94), control: point(0.02, 0.96))
        path.addCurve(to: point(0.48, 0.60), control1: point(0.15, 0.99), control2: point(0.31, 0.81))
        path.closeSubpath()
        path.move(to: point(0.52, 0.40))
        path.addCurve(to: point(0.90, 0.06), control1: point(0.69, 0.19), control2: point(0.85, 0.01))
        path.addQuadCurve(to: point(0.98, 0.20), control: point(0.98, 0.04))
        path.addLine(to: point(0.98, 0.80))
        path.addQuadCurve(to: point(0.90, 0.94), control: point(0.98, 0.96))
        path.addCurve(to: point(0.52, 0.60), control1: point(0.85, 0.99), control2: point(0.69, 0.81))
        path.closeSubpath()
        return path
    }
}

#if os(macOS)
private struct FridayAvatarPointer: NSViewRepresentable {
    let changed: (CGPoint) -> Void
    func makeNSView(context: Context) -> FridayAvatarPointerView { FridayAvatarPointerView() }
    func updateNSView(_ view: FridayAvatarPointerView, context: Context) { view.changed = changed }
    static func dismantleNSView(_ view: FridayAvatarPointerView, coordinator: ()) { view.stop() }
}

private final class FridayAvatarPointerView: NSView {
    var changed: ((CGPoint) -> Void)?
    private weak var surface: NSView?
    private var tracking: NSTrackingArea?
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stop()
        guard let content = window?.contentView else { return }
        // Watch the window so the eyes can follow a pointer beside the avatar,
        // without covering the transcript or intercepting any clicks/scrolls.
        let area = NSTrackingArea(rect: .zero,
            options: [.inVisibleRect, .activeInKeyWindow, .mouseMoved, .mouseEnteredAndExited], owner: self)
        surface = content; tracking = area
        content.addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { mouseMoved(with: event) }
    override func mouseMoved(with event: NSEvent) {
        guard event.window === window, !isHiddenOrHasHiddenAncestor, !visibleRect.isEmpty else { return }
        let point = convert(event.locationInWindow, from: nil)
        let dx = point.x - bounds.midX
        let dy = (point.y - bounds.midY) * (isFlipped ? 1 : -1)
        let distance = max(140, hypot(dx, dy))
        changed?(CGPoint(x: dx / distance, y: dy / distance))
    }
    override func mouseExited(with event: NSEvent) { changed?(.zero) }
    func stop() {
        if let tracking { surface?.removeTrackingArea(tracking) }
        tracking = nil; surface = nil
    }
}
#endif
