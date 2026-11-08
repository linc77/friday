import Foundation

/// Geometry shared by the moving tab lens and its release destination.
struct FridayMobileTabLayout {
    let width: CGFloat
    let count: Int
    let spacing: CGFloat

    init(width: CGFloat, count: Int, spacing: CGFloat = 6) {
        precondition(count > 0)
        self.width = max(0, width)
        self.count = count
        self.spacing = spacing
    }

    var itemWidth: CGFloat { max(0, (width - spacing * CGFloat(count - 1)) / CGFloat(count)) }

    func center(for index: Int) -> CGFloat {
        guard itemWidth > 0 else { return 0 }
        return itemWidth / 2 + CGFloat(min(max(index, 0), count - 1)) * (itemWidth + spacing)
    }

    func lensCenter(at x: CGFloat) -> CGFloat {
        min(max(x, center(for: 0)), center(for: count - 1))
    }

    func index(at x: CGFloat) -> Int {
        Int(position(at: x).rounded())
    }

    func position(at x: CGFloat) -> CGFloat {
        guard itemWidth > 0 else { return 0 }
        return (lensCenter(at: x) - center(for: 0)) / (itemWidth + spacing)
    }

    func center(at position: CGFloat) -> CGFloat {
        guard itemWidth > 0 else { return 0 }
        return center(for: 0) + min(max(position, 0), CGFloat(count - 1)) * (itemWidth + spacing)
    }
}

/// Lock to the initial drag direction; cancellation never changes the selected page.
struct FridayMobileTabDrag {
    static let minimumDistance: CGFloat = 4
    private enum Direction { case undecided, horizontal, vertical }
    private var direction = Direction.undecided
    private(set) var location: CGPoint?

    var isHorizontal: Bool { direction == .horizontal }

    mutating func update(start: CGPoint, location: CGPoint) {
        if direction == .undecided {
            let dx = abs(location.x - start.x)
            let dy = abs(location.y - start.y)
            guard max(dx, dy) >= Self.minimumDistance else { return }
            direction = dx > dy ? .horizontal : .vertical
        }
        if isHorizontal { self.location = location }
    }

    mutating func finish(in layout: FridayMobileTabLayout) -> Int? {
        let destination = isHorizontal ? location.map { layout.index(at: $0.x) } : nil
        cancel()
        return destination
    }

    mutating func cancel() { self = Self() }
}

/// Share fractional tab positions, not pixels, between differently sized docks.
/// Only the row owning the gesture can finish/cancel it; hidden retained rows
/// must not clear another row's touch when their lifecycle changes.
struct FridayMobileTabScrub {
    private var owner: UUID?
    private var drag = FridayMobileTabDrag()
    private(set) var position: CGFloat?
    var isHorizontal: Bool { drag.isHorizontal }

    mutating func update(owner: UUID, start: CGPoint, location: CGPoint, layout: FridayMobileTabLayout) {
        guard self.owner == nil || self.owner == owner else { return }
        self.owner = owner
        drag.update(start: start, location: location)
        if let location = drag.location { position = layout.position(at: location.x) }
    }

    mutating func finish(owner: UUID, in layout: FridayMobileTabLayout) -> Int? {
        guard self.owner == owner else { return nil }
        let destination = drag.finish(in: layout)
        self = Self()
        return destination
    }

    mutating func cancel(owner: UUID) {
        if self.owner == owner { self = Self() }
    }
}
