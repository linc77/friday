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
            // Keep the fine velvet texture at every display scale. The source
            // has transparent margins; normalize its visible sphere here.
            Image("FridayAvatarBody", bundle: .module)
                .renderingMode(.original)
                .resizable()
                .interpolation(.high)
                .frame(width: size * 1.30, height: size * 1.30)
                .offset(x: size * 0.002, y: -size * 0.014)
                .frame(width: size * 0.96, height: size * 0.96)
                .clipped()
                .offset(y: -size * 0.02)

            HStack(spacing: size * 0.105) {
                eye
                eye
            }
            .rotationEffect(.degrees(Double(gaze.x) * 3))
            .offset(x: gaze.x * size * 0.065, y: -size * 0.105 + gaze.y * size * 0.045)

            FridayBowTie()
                .fill(LinearGradient(colors: [Color(white: 0.17), Color(white: 0.055)], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: size * 0.475, height: size * 0.195)
                .overlay {
                    Ellipse()
                        .fill(Color(white: 0.10))
                        .frame(width: size * 0.035, height: size * 0.045)
                }
                .shadow(color: .black.opacity(0.20), radius: size * 0.012, y: -size * 0.012)
                .rotationEffect(.degrees(Double(gaze.x) * 1.5))
                .offset(y: size * 0.40)
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
        Ellipse()
            .fill(LinearGradient(colors: [Color(white: 0.16), Color(white: 0.08)],
                startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: size * 0.088, height: size * 0.136)
            .shadow(color: .black.opacity(0.28), radius: size * 0.009, x: size * 0.003, y: size * 0.008)
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
