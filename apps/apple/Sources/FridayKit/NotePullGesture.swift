/// A pull can start only at the top of the gallery, with a fresh, precise scroll
/// gesture. Lock its direction so normal scrolling cannot turn into creation.
struct NotePullGesture {
    static let threshold: Double = 120
    enum Phase { case began, changed, ended, cancelled, none }
    struct Update {
        var consumed = false
        var distance: Double = 0
        var shouldCreate = false
    }
    private enum Direction { case undecided, pull, scroll }
    private var direction: Direction = .undecided
    private var tracking = false
    private var consumesMomentum = false
    private var x: Double = 0
    private var y: Double = 0

    mutating func update(x dx: Double, y dy: Double, phase: Phase,
                         precise: Bool, momentum: Bool, canStart: Bool) -> Update {
        if momentum {
            let consume = consumesMomentum
            if phase == .ended || phase == .cancelled { consumesMomentum = false }
            return Update(consumed: consume)
        }
        if phase == .began {
            self = NotePullGesture()
            tracking = precise && canStart
        }
        guard tracking, precise, phase != .none else { return Update() }
        if phase != .cancelled {
            x += dx; y += dy
            if direction == .undecided, max(abs(x), abs(y)) >= 8 {
                direction = y > abs(x) * 1.25 ? .pull : .scroll
            }
        }
        // Hold tiny downward deltas while deciding, avoiding a second native
        // rubber-band animation underneath the custom reveal.
        let consumed = direction == .pull || (direction == .undecided && y > abs(x))
        let distance = direction == .pull ? max(0, y) : 0
        if phase == .ended || phase == .cancelled {
            tracking = false; consumesMomentum = consumed
            return Update(consumed: consumed, shouldCreate: phase == .ended && distance >= Self.threshold)
        }
        return Update(consumed: consumed, distance: distance)
    }
}
