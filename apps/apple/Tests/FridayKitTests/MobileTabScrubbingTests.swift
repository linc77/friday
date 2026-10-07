import Foundation

@main
struct MobileTabScrubbingTests {
    static func main() {
        for width: CGFloat in [268, 338, 760] {
            let layout = FridayMobileTabLayout(width: width, count: 4)
            for index in 0..<4 {
                precondition(layout.index(at: layout.center(for: index)) == index)
            }
            precondition(layout.index(at: -100) == 0, "Overshooting the left edge stays on the first tab")
            precondition(layout.index(at: width + 100) == 3, "Overshooting the right edge stays on the last tab")

            var drag = FridayMobileTabDrag()
            let start = CGPoint(x: layout.center(for: 0), y: 22)
            for index in 1..<4 {
                drag.update(start: start, location: CGPoint(x: layout.center(for: index), y: 22))
                precondition(layout.index(at: drag.location!.x) == index, "A single drag can cross every tab")
            }
            precondition(drag.finish(in: layout) == 3)
            precondition(drag.location == nil && !drag.isHorizontal)

            let reverseStart = CGPoint(x: layout.center(for: 3), y: 22)
            for index in (0..<3).reversed() {
                drag.update(start: reverseStart, location: CGPoint(x: layout.center(for: index), y: 22))
            }
            precondition(drag.finish(in: layout) == 0, "A full right-to-left drag returns to the first tab")

            // Turning back before release selects the final position, not the furthest tab.
            drag.update(start: start, location: CGPoint(x: layout.center(for: 3), y: 22))
            drag.update(start: start, location: CGPoint(x: layout.center(for: 1), y: 22))
            precondition(drag.finish(in: layout) == 1)

            drag.update(start: start, location: CGPoint(x: layout.center(for: 2), y: 22))
            drag.cancel()
            precondition(drag.finish(in: layout) == nil, "Cancelled drags cannot switch pages")

            // A vertical movement cannot become a navigation swipe later in the gesture.
            drag.update(start: start, location: CGPoint(x: start.x + 2, y: 42))
            drag.update(start: start, location: CGPoint(x: width, y: 42))
            precondition(drag.finish(in: layout) == nil)

            drag.update(start: start, location: CGPoint(x: start.x + 3, y: 23))
            precondition(drag.finish(in: layout) == nil, "Tap jitter does not start a drag")
        }
        let emptyLayout = FridayMobileTabLayout(width: 0, count: 4)
        precondition(emptyLayout.index(at: 100) == 0 && emptyLayout.lensCenter(at: 100) == 0)
        let singleTab = FridayMobileTabLayout(width: 338, count: 1)
        precondition(singleTab.index(at: 338) == 0 && singleTab.center(for: 0) == 169)
        print("Mobile tab scrubbing: both directions, reversal, cancellation, vertical drags and edge clamping passed")
    }
}
