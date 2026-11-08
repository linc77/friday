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
    static let duration: TimeInterval = 0.18
    func value(at time: TimeInterval) -> CGFloat {
        let t = min(max((time - start) / Self.duration, 0), 1)
        return from + (to - from) * CGFloat(1 - pow(1 - t, 3))
    }
    func finished(at time: TimeInterval) -> Bool { time >= start + Self.duration }
}

#if os(iOS)
import SwiftUI
import UIKit
import Observation

@MainActor @Observable
final class FridayNavigationMotion {
    private(set) var position: CGFloat = 0
    @ObservationIgnored private var target: CGFloat = 0
    @ObservationIgnored private var transition: FridayNavigationTransition?
    @ObservationIgnored private var displayLink: CADisplayLink?
    @ObservationIgnored private var dragOwner: UUID?

    func move(to index: Int, animated: Bool) {
        let destination = CGFloat(index)
        dragOwner = nil
        if !animated { stop(); target = destination; position = destination; return }
        if target == destination, displayLink != nil { return }
        stop()
        target = destination
        guard abs(position - destination) > 0.001 else { position = destination; return }
        transition = .init(from: position, to: destination, start: CACurrentMediaTime())
        let proxy = FridayNavigationFrameTarget(owner: self)
        let link = CADisplayLink(target: proxy, selector: #selector(FridayNavigationFrameTarget.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
        displayLink = link
        link.add(to: .main, forMode: .common)
    }

    func drag(to position: CGFloat, owner: UUID) {
        guard dragOwner == nil || dragOwner == owner else { return }
        stop()
        dragOwner = owner
        self.position = position
    }

    func cancelDrag(owner: UUID, selection: Int, animated: Bool) {
        guard dragOwner == owner else { return }
        move(to: selection, animated: animated)
    }

    fileprivate func tick(_ link: CADisplayLink) {
        guard let transition else { stop(); return }
        let now = CACurrentMediaTime()
        position = transition.value(at: now)
        if transition.finished(at: now) { stop() }
    }

    private func stop() {
        displayLink?.invalidate()
        displayLink = nil
        transition = nil
    }

    deinit { displayLink?.invalidate() }
}

@MainActor private final class FridayNavigationFrameTarget: NSObject {
    weak var owner: FridayNavigationMotion?
    init(owner: FridayNavigationMotion) { self.owner = owner }
    @objc func tick(_ link: CADisplayLink) {
        guard let owner else { link.invalidate(); return }
        owner.tick(link)
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
