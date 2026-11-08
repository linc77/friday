import XCTest
import SwiftUI
@testable import FridayKit
#if os(macOS)
import AppKit

final class FridayCursorTests: XCTestCase {
    @MainActor func testModernControlsHaveNoCompetingNativeCursorOwner() async throws {
        guard #available(macOS 15.0, *) else { throw XCTSkip("Native Pointer Style requires macOS 15") }
        let root = NSHostingView(rootView: Button("Settings") {}.fridayInteractiveCursor())
        let window = CursorWindow(contentRect: NSRect(x: 0, y: 0, width: 120, height: 60),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = root
        defer { window.contentView = nil }
        for _ in 0..<8 { root.layoutSubtreeIfNeeded(); await Task.yield() }
        func hasLegacyOwner(_ view: NSView) -> Bool {
            view is FridayLegacyCursorView || view.subviews.contains(where: hasLegacyOwner)
        }
        XCTAssertFalse(hasLegacyOwner(root), "SwiftUI controls must have one cursor owner, without an AppKit overlay resetting it")
    }

    @MainActor func testLegacyCursorSurvivesNativePageReplacementAndEnabledChanges() async throws {
        let state = CursorFixtureState()
        let root = NSHostingView(rootView: CursorFixture(state: state))
        let window = CursorWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 300),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = root
        defer { window.contentView = nil }
        func settle() async {
            for _ in 0..<8 { root.layoutSubtreeIfNeeded(); await Task.yield() }
        }
        func regions(in view: NSView) -> [NSView] {
            let own = String(describing: type(of: view)) == "FridayLegacyCursorView" ? [view] : []
            return own + view.subviews.flatMap { regions(in: $0) }
        }
        await settle()
        let cursor = try XCTUnwrap(regions(in: root).first)
        XCTAssertEqual(regions(in: root).count, 1)
        XCTAssertEqual(cursor.bounds.size, NSSize(width: 32, height: 32))
        XCTAssertNil(cursor.hitTest(NSPoint(x: 16, y: 16)), "The cursor region must not intercept button clicks")
        cursor.updateTrackingAreas()
        XCTAssertTrue(cursor.trackingAreas.isEmpty, "Cursor rectangles must not compete with mouse-move tracking")

        for page in ["task", "ideas", "task", "workspace", "task"] {
            state.page = page; await settle()
            XCTAssertTrue(regions(in: root).first === cursor, "Replacing native page hosts must preserve the rail's cursor owner")
            XCTAssertTrue(cursor.window === window)
            XCTAssertEqual(cursor.bounds.size, NSSize(width: 32, height: 32))
        }

        window.invalidations.removeAll()
        for _ in 0..<12 { state.revision += 1; await settle() }
        XCTAssertFalse(window.invalidations.contains(ObjectIdentifier(cursor)), "Unchanged enabled state must not reset the pointer on ordinary view updates")

        for enabled in [false, true] {
            window.invalidations.removeAll()
            state.enabled = enabled; await settle()
            XCTAssertTrue(window.invalidations.contains(ObjectIdentifier(cursor)), "Disabling and re-enabling must refresh the native cursor region")
            XCTAssertTrue(regions(in: root).first === cursor)
            XCTAssertTrue(cursor.trackingAreas.isEmpty)
        }
    }
}

@MainActor private final class CursorFixtureState: ObservableObject {
    @Published var page = "ideas"
    @Published var enabled = true
    @Published var revision = 0
}

private struct CursorFixture: View {
    @ObservedObject var state: CursorFixtureState
    var body: some View {
        HStack(spacing: 0) {
            Button {} label: { Text("\(state.revision)").frame(width: 32, height: 32) }
                .buttonStyle(.plain)
                .background(FridayLegacyCursorRegion(enabled: state.enabled))
                .disabled(!state.enabled)
            FridayRetainedPages(selection: state.page, scope: "cursor-test") {
                Text(state.page).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

@MainActor private final class CursorWindow: NSWindow {
    var invalidations: [ObjectIdentifier] = []
    override func invalidateCursorRects(for view: NSView) {
        invalidations.append(ObjectIdentifier(view))
        super.invalidateCursorRects(for: view)
    }
}
#endif
