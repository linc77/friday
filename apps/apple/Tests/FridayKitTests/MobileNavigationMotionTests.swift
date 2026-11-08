import Foundation

@main
enum MobileNavigationMotionTests {
    static func main() {
        let layout = FridayNavigationGeometry(width: 342, count: 4)
        // Finger positions outside the dock must never select a nonexistent tab.
        precondition(layout.index(at: -100) == 0)
        precondition(layout.index(at: 500) == 3)
        for index in 0..<4 {
            let center = layout.itemWidth / 2 + CGFloat(index) * (layout.itemWidth + layout.spacing)
            precondition(layout.index(at: center) == index)
        }
        let midpoint = layout.itemWidth / 2 + 1.5 * (layout.itemWidth + layout.spacing)
        precondition(layout.index(at: midpoint - 0.1) == 1)
        precondition(layout.index(at: midpoint + 0.1) == 2)
        precondition(FridayNavigationGeometry(width: 0, count: 4).index(at: 100) == 0)

        var drag = FridayNavigationDrag()
        drag.update(start: CGPoint(x: 0, y: 0), location: CGPoint(x: 2, y: 1))
        precondition(!drag.isHorizontal)
        drag.update(start: CGPoint(x: 0, y: 0), location: CGPoint(x: 8, y: 1))
        precondition(drag.isHorizontal)
        drag.update(start: CGPoint(x: 0, y: 0), location: CGPoint(x: 8, y: 40))
        precondition(drag.isHorizontal) // Keep direction after recognition.
        var vertical = FridayNavigationDrag()
        vertical.update(start: CGPoint(x: 0, y: 0), location: CGPoint(x: 1, y: 8))
        vertical.update(start: CGPoint(x: 0, y: 0), location: CGPoint(x: 40, y: 8))
        precondition(!vertical.isHorizontal)

        let first = FridayNavigationTransition(from: 0, to: 3, start: 10)
        precondition(first.value(at: 9) == 0)
        let halfway = first.value(at: 10.09)
        precondition(halfway > 0 && halfway < 3)
        // A quick second tap reverses from the presented position, not a tab center.
        let retargeted = FridayNavigationTransition(from: halfway, to: 0, start: 10.09)
        precondition(retargeted.value(at: 10.09) == halfway)
        precondition(retargeted.value(at: 10.12) < halfway)
        precondition(retargeted.value(at: 11) == 0 && retargeted.finished(at: 11))
        precondition(first.value(at: 11) == 3 && first.finished(at: 11))
        print("Mobile navigation motion checks passed")
    }
}
