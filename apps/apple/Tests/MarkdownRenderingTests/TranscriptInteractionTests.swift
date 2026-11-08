import XCTest
import SwiftUI
import Observation
@testable import FridayKit

#if os(macOS)
import AppKit

final class TranscriptInteractionTests: XCTestCase {
    @MainActor @Observable fileprivate final class ComposerInput {
        var expansion: CGFloat = 1
        var editorHeight: CGFloat = 160
    }
    private final class Heights { var values: [CGFloat] = [] }

    private struct Composer: View {
        let input: ComposerInput
        let geometry: TaskComposerGeometry
        let reserved: Heights
        var body: some View {
            TaskComposerLayout(expansion: input.expansion) {
                Color.clear.frame(height: input.editorHeight)
                    .modifier(TaskComposerMeasurement())
            }
            .modifier(TaskComposerReservation(expanded: input.expansion > 0))
            .padding(.vertical, 12)
            .environment(\.taskComposerGeometry, geometry)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { height in
                geometry.reservedHeight = height
                reserved.values.append(height)
            }
        }
    }

    @MainActor func testComposerAnimationDoesNotResizeTranscriptReservation() async {
        let input = ComposerInput(), geometry = TaskComposerGeometry(), heights = Heights()
        let root = NSHostingView(rootView: VStack {
            Spacer()
            Composer(input: input, geometry: geometry, reserved: heights)
        })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = root
        defer { window.contentView = nil }
        func settle() async { for _ in 0..<8 { root.layoutSubtreeIfNeeded(); await Task.yield() } }
        await settle()
        XCTAssertEqual(geometry.reservedHeight, 184, accuracy: 0.5)
        XCTAssertTrue(geometry.requestCollapse())
        XCTAssertFalse(geometry.requestCollapse(), "Repeated wheel samples request one fold")
        heights.values.removeAll()
        for step in stride(from: 59, through: 0, by: -1) {
            input.expansion = CGFloat(step) / 60
            await settle()
        }
        XCTAssertTrue(heights.values.isEmpty, "Animation frames must not change the transcript document height")
        XCTAssertEqual(geometry.occlusionHeight, 68, accuracy: 0.5, "Only the collapsed surface excludes wheel input")
        input.editorHeight = 260 // Attachments, wrapping or a multi-line draft still change natural size.
        await settle()
        XCTAssertEqual(geometry.reservedHeight, 284, accuracy: 0.5)
        XCTAssertEqual(geometry.occlusionHeight, 68, accuracy: 0.5)
        input.expansion = 1
        await settle()
        XCTAssertEqual(geometry.occlusionHeight, 284, accuracy: 0.5)
        XCTAssertTrue(geometry.requestCollapse(), "Manually reopening must allow the next history gesture to fold again")
    }

    func testLayoutChangesDoNotLookLikeUserScrollDirection() {
        let tracking = TranscriptScrollTracking()
        _ = tracking.update(.init(top: -500, bottom: 600, viewportHeight: 600))
        // Streaming and bottom alignment change both content size and offset.
        let streamed = tracking.update(.init(top: -540, bottom: 600, viewportHeight: 600))
        XCTAssertFalse(streamed.up)
        XCTAssertFalse(streamed.down)
        XCTAssertTrue(streamed.atBottom)
        // Resizing the viewport can also clamp the offset without user input.
        let resized = tracking.update(.init(top: -440, bottom: 700, viewportHeight: 700))
        XCTAssertFalse(resized.up)
        XCTAssertFalse(resized.down)
        let history = tracking.update(.init(top: -400, bottom: 740, viewportHeight: 700))
        XCTAssertTrue(history.up)
        XCTAssertFalse(history.down)
        XCTAssertFalse(history.atBottom)
        let latest = tracking.update(.init(top: -440, bottom: 700, viewportHeight: 700))
        XCTAssertTrue(latest.down)
        XCTAssertTrue(latest.atBottom)
    }

    private struct OverflowingNativeContent: NSViewRepresentable {
        func makeNSView(context: Context) -> OverflowProbe { OverflowProbe() }
        func updateNSView(_ view: OverflowProbe, context: Context) {}
    }
    private final class OverflowProbe: NSView {
        let child = NSView(frame: NSRect(x: -300, y: 0, width: 2_000, height: 2_000))
        init() { super.init(frame: .zero); addSubview(child) }
        required init?(coder: NSCoder) { fatalError() }
    }

    @MainActor func testNativePaneContainsDescendantDrawingDuringResize() async throws {
        let root = NSHostingView(rootView: TaskPanelSplitView(width: .constant(460), visible: true,
            main: Color.gray, panel: { OverflowingNativeContent() }))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 600),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = root
        defer { window.contentView = nil }
        func settle() async { for _ in 0..<8 { root.layoutSubtreeIfNeeded(); await Task.yield() } }
        func find<T: NSView>(_ type: T.Type, in view: NSView) -> T? {
            (view as? T) ?? view.subviews.lazy.compactMap { find(type, in: $0) }.first
        }
        await settle()
        let split = try XCTUnwrap(find(TaskPanelSplitHost.self, in: root))
        let probe = try XCTUnwrap(find(OverflowProbe.self, in: split))
        split.beginResize(at: 700)
        for x in stride(from: 700, through: 400, by: -30) {
            split.resize(to: CGFloat(x)); await settle()
            let drawn = probe.convert(probe.child.visibleRect, from: probe.child)
            XCTAssertGreaterThanOrEqual(drawn.minX, -0.5, "A native descendant cannot draw into the neighboring pane")
            XCTAssertLessThanOrEqual(drawn.maxX, probe.bounds.maxX + 0.5)
        }
        split.finishResize()
    }
}
#endif
