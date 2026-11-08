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
        let outgoing = FridayMobileTabLayout(width: 338, count: 4)
        let incoming = FridayMobileTabLayout(width: 300, count: 4)
        let owner = UUID(), hiddenRow = UUID()
        let start = CGPoint(x: outgoing.center(for: 0), y: 22)
        var scrub = FridayMobileTabScrub()
        scrub.update(owner: owner, start: start, location: CGPoint(x: start.x + 4, y: 22), layout: outgoing)
        precondition(scrub.isHorizontal && scrub.position != nil, "Tracking starts after 4 pt instead of the old 8 pt dead zone")
        scrub.update(owner: owner, start: start, location: CGPoint(x: outgoing.center(at: 1.5), y: 22), layout: outgoing)
        precondition(abs(scrub.position! - 1.5) < 0.0001)
        precondition(abs(incoming.position(at: incoming.center(at: scrub.position!)) - 1.5) < 0.0001,
                     "The incoming dock inherits the same fractional position at a different width")
        scrub.cancel(owner: hiddenRow)
        precondition(scrub.position != nil, "Hidden row lifecycle changes cannot cancel the visible row's gesture")
        precondition(scrub.finish(owner: hiddenRow, in: incoming) == nil)
        precondition(scrub.finish(owner: owner, in: outgoing) == 2)
        precondition(scrub.position == nil && !scrub.isHorizontal)
        scrub.update(owner: owner, start: start, location: CGPoint(x: start.x, y: 40), layout: outgoing)
        precondition(scrub.position == nil && scrub.finish(owner: owner, in: outgoing) == nil)
        print("Mobile tab scrubbing: both directions, reversal, cancellation, vertical drags and edge clamping passed")
    }
}
