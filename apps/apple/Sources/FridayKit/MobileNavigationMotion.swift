import Foundation

struct FridayNavigationGeometry {
    let width: CGFloat
    let count: Int
    let spacing: CGFloat = 6
    var itemWidth: CGFloat { max(0, (width - spacing * CGFloat(count - 1)) / CGFloat(count)) }
    func position(at x: CGFloat) -> CGFloat {
        guard itemWidth > 0 else { return 0 }
        return min(max((x - itemWidth / 2) / (itemWidth + spacing), 0), CGFloat(count - 1))
    }
    func index(at x: CGFloat) -> Int { Int(position(at: x).rounded()) }
}

struct FridayNavigationDrag {
    static let minimumDistance: CGFloat = 4
    private var horizontal: Bool?
    var isHorizontal: Bool { horizontal == true }
    mutating func update(start: CGPoint, location: CGPoint) {
        guard horizontal == nil else { return }
        let dx = abs(location.x - start.x), dy = abs(location.y - start.y)
        if max(dx, dy) >= Self.minimumDistance { horizontal = dx > dy }
    }
}

/// Timing is independent of which page currently owns the visible dock.
struct FridayNavigationTransition {
    let from: CGFloat
    let to: CGFloat
    let start: TimeInterval
    static let duration: TimeInterval = 0.22
    func value(at time: TimeInterval) -> CGFloat {
        let t = min(max((time - start) / Self.duration, 0), 1)
        return from + (to - from) * CGFloat(t)
    }
    func finished(at time: TimeInterval) -> Bool { time >= start + Self.duration }
}

#if os(iOS)
import SwiftUI
import UIKit
import Observation

/// Slides are pinned to an absolute media time and rendered by Core Animation,
/// so every page's capsule shows the same frame and main-thread work can't stall it.
@MainActor @Observable
final class FridayNavigationMotion {
    private(set) var transition = FridayNavigationTransition(from: 0, to: 0, start: 0)
    @ObservationIgnored private var dragOwner: UUID?
    @ObservationIgnored private var handles: [FridayCapsuleHandle] = []

    func register(_ handle: FridayCapsuleHandle) {
        handles.removeAll { $0.layer == nil }
        if !handles.contains(where: { $0 === handle }) { handles.append(handle) }
    }

    /// Attach the slide to every live capsule layer in the same call as the touch.
    private func push() {
        handles.removeAll { $0.layer == nil }
        for handle in handles { handle.apply(transition) }
    }

    func move(to index: Int, animated: Bool) {
        let destination = CGFloat(index)
        dragOwner = nil
        let now = CACurrentMediaTime()
        if animated, transition.to == destination { return }
        let current = transition.value(at: now)
        transition = animated && abs(current - destination) > 0.001
            ? .init(from: current, to: destination, start: now)
            : .init(from: destination, to: destination, start: now)
        push()
    }

    func drag(to position: CGFloat, owner: UUID) {
        guard dragOwner == nil || dragOwner == owner else { return }
        dragOwner = owner
        transition = .init(from: position, to: position, start: CACurrentMediaTime())
        push()
    }

    func cancelDrag(owner: UUID, selection: Int, animated: Bool) {
        guard dragOwner == owner else { return }
        move(to: selection, animated: animated)
    }
}

@MainActor final class FridayCapsuleHandle {
    weak var layer: CALayer?
    var step: CGFloat = 0
    var size: CGSize = .zero
    private var applied: (CGFloat, CGFloat, TimeInterval, CGFloat, CGFloat)?

    func apply(_ transition: FridayNavigationTransition) {
        guard let layer, size.width > 0 else { return }
        let key = (transition.from, transition.to, transition.start, step, size.width)
        if let applied, applied == key { return }
        applied = key
        let x = { (p: CGFloat) in p * self.step + self.size.width / 2 }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.bounds = CGRect(origin: .zero, size: size)
        layer.cornerRadius = size.height / 2
        layer.position = CGPoint(x: x(transition.to), y: size.height / 2)
        layer.removeAnimation(forKey: "slide")
        if transition.from != transition.to, !transition.finished(at: CACurrentMediaTime()) {
            let slide = CABasicAnimation(keyPath: "position.x")
            slide.fromValue = x(transition.from)
            slide.toValue = x(transition.to)
            slide.duration = FridayNavigationTransition.duration
            slide.beginTime = layer.convertTime(transition.start, from: nil)
            slide.fillMode = .backwards
            slide.timingFunction = CAMediaTimingFunction(name: .linear)
            layer.add(slide, forKey: "slide")
        }
        CATransaction.commit()
    }
}

struct FridayNavigationCapsule: UIViewRepresentable {
    let motion: FridayNavigationMotion
    let transition: FridayNavigationTransition
    let step: CGFloat
    let size: CGSize

    func makeCoordinator() -> FridayCapsuleHandle { FridayCapsuleHandle() }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        let capsule = UIView()
        capsule.backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.08) }
        capsule.layer.cornerCurve = .continuous
        view.addSubview(capsule)
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        guard let layer = view.subviews.first?.layer else { return }
        let handle = context.coordinator
        handle.layer = layer
        handle.step = step
        handle.size = size
        motion.register(handle)
        handle.apply(transition)
    }
}

private struct FridayNavigationMotionKey: EnvironmentKey {
    static let defaultValue: FridayNavigationMotion? = nil
}
extension EnvironmentValues {
    var fridayNavigationMotion: FridayNavigationMotion? {
        get { self[FridayNavigationMotionKey.self] }
        set { self[FridayNavigationMotionKey.self] = newValue }
    }
}

struct FridayNavigationMotionHost: ViewModifier {
    let selection: Int
    @State private var motion = FridayNavigationMotion()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    func body(content: Content) -> some View {
        content.environment(\.fridayNavigationMotion, motion)
            .onChange(of: selection, initial: true) { old, new in
                motion.move(to: new, animated: old != new && !reduceMotion && scenePhase == .active)
            }
            .onChange(of: reduceMotion) { _, reduced in
                if reduced { motion.move(to: selection, animated: false) }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { motion.move(to: selection, animated: false) }
            }
            .onDisappear { motion.move(to: selection, animated: false) }
    }
}
#endif
