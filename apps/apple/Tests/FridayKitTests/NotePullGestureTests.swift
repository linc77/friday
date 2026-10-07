@main
struct NotePullGestureTests {
    static func main() {
        var pull = NotePullGesture()
        func event(_ phase: NotePullGesture.Phase, x: Double = 0, y: Double = 0,
                   precise: Bool = true, momentum: Bool = false, atTop: Bool = true) -> NotePullGesture.Update {
            pull.update(x: x, y: y, phase: phase, precise: precise, momentum: momentum, canStart: atTop)
        }

        precondition(event(.began, y: 3).consumed, "Hold initial downward jitter to avoid native rubber-banding")
        let partial = event(.changed, y: 57)
        precondition(partial.consumed && partial.distance == 60 && !partial.shouldCreate)
        precondition(!event(.ended).shouldCreate, "A short pull returns to the gallery")

        _ = event(.began, y: 20)
        let ready = event(.changed, y: 110)
        precondition(ready.distance >= NotePullGesture.threshold && !ready.shouldCreate, "Crossing the threshold does not create until release")
        precondition(event(.ended).shouldCreate)
        precondition(!event(.ended).shouldCreate, "One gesture creates at most one note")
        let inertia = event(.began, y: 250, momentum: true)
        precondition(inertia.consumed && !inertia.shouldCreate, "Momentum cannot start another pull")
        _ = event(.ended, momentum: true)
        precondition(!event(.changed, y: 250, momentum: true).shouldCreate)

        _ = event(.began, y: 150)
        _ = event(.changed, y: -90)
        precondition(!event(.ended).shouldCreate, "Reversing before release disarms creation")
        _ = event(.began, y: 150)
        precondition(!event(.cancelled).shouldCreate, "System cancellation never creates a note")

        precondition(!event(.began, x: 30, y: 3).consumed)
        precondition(!event(.changed, y: 240).consumed, "A horizontal gesture stays a normal scroll after vertical drift")
        precondition(!event(.ended).shouldCreate)
        precondition(!event(.began, y: -30).consumed)
        precondition(!event(.changed, y: 240).consumed, "Scrolling down the list cannot reverse into creation")
        precondition(!event(.ended).shouldCreate)

        precondition(!event(.began, y: 50, atTop: false).consumed)
        precondition(!event(.changed, y: 240).consumed, "Reaching the top from mid-list requires a fresh pull")
        precondition(!event(.ended).shouldCreate)
        precondition(!event(.began, y: 250, precise: false).consumed)
        precondition(!event(.ended, precise: false).shouldCreate, "A mouse wheel cannot create a note")
        precondition(!event(.none, y: 250).consumed)

        _ = event(.began, y: 150)
        pull = NotePullGesture()
        precondition(!event(.ended).shouldCreate, "Leaving the gallery or deactivating the app cancels the gesture")
        _ = event(.began, y: 120)
        precondition(event(.ended).shouldCreate, "A new gesture can create after cancellation")
        print("Note pull reveal, release threshold, reversal, cancellation, axis lock, top boundary, mouse and momentum checks passed")
    }
}
