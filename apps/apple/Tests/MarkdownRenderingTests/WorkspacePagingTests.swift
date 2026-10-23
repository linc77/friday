import XCTest
#if os(macOS)
import AppKit
import SwiftUI
@testable import FridayKit

final class WorkspacePagingTests: XCTestCase {
    @MainActor func testTrackpadSamplesDoNotRebuildPagesAndDataChangesStillRefresh() async throws {
        let fixture = PagingFixture()
        let host = NSHostingView(rootView: PagingFixtureView(fixture: fixture))
        host.frame = NSRect(x: 0, y: 0, width: 280, height: 600)
        await layout(host)
        let gesture = try XCTUnwrap(findGesture(host))
        let viewport = try XCTUnwrap(findViewport(host))
        let initial = fixture.builds
        let initialRenders = fixture.renders
        XCTAssertGreaterThan(initial, 0)
        XCTAssertGreaterThan(initialRenders, 0)
        XCTAssertEqual(fixture.renderedRowPages, ["all", "a", "b"], "Lazy rows on both adjacent pages must be prepared before dragging")

        // Flush a separate layout for every sample so coalescing cannot hide
        // an expensive page builder running at trackpad frequency.
        for sample in 1...60 {
            gesture.changed?(-Double(sample))
            XCTAssertEqual(viewport.translation, -CGFloat(sample))
            XCTAssertEqual(viewport.layer?.sublayerTransform.m41, -CGFloat(sample), "A sample must synchronously move the native layer")
            await layout(host)
        }
        XCTAssertEqual(fixture.builds, initial, "Dragging must move existing pages without filtering and rebuilding their lists")
        XCTAssertEqual(fixture.renders, initialRenders, "Task contents must not render again for offset-only updates")

        fixture.revision += 1
        await layout(host)
        XCTAssertGreaterThan(fixture.builds, initial, "Real task updates must still rebuild page contents")
        XCTAssertTrue(fixture.renderedRevisions.contains(1))
        XCTAssertEqual(viewport.translation, -60, "A task update must not cancel a drag")
        XCTAssertTrue(fixture.renderedLocales.contains("en"), "Hosted pages must inherit the sidebar environment")
    }

    @MainActor func testSelectionCommitsAfterTheNativeSpringAndResetsTheLayer() async throws {
        let fixture = PagingFixture()
        let host = NSHostingView(rootView: PagingFixtureView(fixture: fixture))
        host.frame = NSRect(x: 0, y: 0, width: 280, height: 600)
        await layout(host)
        let gesture = try XCTUnwrap(findGesture(host))
        let viewport = try XCTUnwrap(findViewport(host))
        var swipe = WorkspaceSwipe()
        _ = swipe.update(x: -100, y: 0)
        gesture.changed?(swipe.x)
        gesture.ended?(swipe, false)
        XCTAssertEqual(fixture.selection, "a", "Filtering must wait until the visual transition finishes")
        XCTAssertEqual(viewport.translation, -280)
        XCTAssertFalse(viewport.layer?.animationKeys()?.isEmpty ?? true)

        try await Task.sleep(for: .seconds(FridayTheme.motionResponse + 0.08))
        await layout(host)
        XCTAssertEqual(fixture.selection, "b")
        XCTAssertEqual(fixture.selections, ["b"])
        XCTAssertEqual(viewport.translation, 0, "The new root and native transform must hand off together")
        XCTAssertTrue(viewport.layer?.animationKeys()?.isEmpty ?? true)
    }

    @MainActor func testCancelledGestureAndHostSwitchCannotCommitAStaleSelection() async throws {
        let fixture = PagingFixture()
        let host = NSHostingView(rootView: PagingFixtureView(fixture: fixture))
        host.frame = NSRect(x: 0, y: 0, width: 280, height: 600)
        await layout(host)
        let gesture = try XCTUnwrap(findGesture(host))
        let viewport = try XCTUnwrap(findViewport(host))
        var swipe = WorkspaceSwipe()
        _ = swipe.update(x: -100, y: 0)
        gesture.changed?(swipe.x)
        gesture.ended?(swipe, true)
        try await Task.sleep(for: .seconds(FridayTheme.motionResponse + 0.08))
        XCTAssertEqual(fixture.selection, "a")
        XCTAssertTrue(fixture.selections.isEmpty)
        XCTAssertEqual(viewport.translation, 0)

        gesture.changed?(swipe.x)
        gesture.ended?(swipe, false)
        fixture.context = "another-host"
        fixture.selection = nil
        await layout(host)
        try await Task.sleep(for: .seconds(FridayTheme.motionResponse + 0.08))
        await layout(host)
        XCTAssertNil(fixture.selection)
        XCTAssertTrue(fixture.selections.isEmpty, "A spring completion from the previous host must be ignored")
        XCTAssertEqual(viewport.translation, 0)
    }

    @MainActor func testReducedMotionChangesScopeWithoutTranslatingOrAnimating() async throws {
        let viewport = WorkspacePageViewport(frame: NSRect(x: 0, y: 0, width: 280, height: 600))
        let size = viewport.bounds.size
        var selections: [String?] = []
        viewport.update(WorkspacePageConfiguration(pages: [nil, "a", "b"], selection: "a", context: "host", animated: false),
            size: size, content: AnyView(Text("page")), select: { selections.append($0) })
        let gesture = try XCTUnwrap(findGesture(viewport))
        var swipe = WorkspaceSwipe()
        _ = swipe.update(x: -100, y: 0)
        gesture.changed?(swipe.x)
        XCTAssertEqual(viewport.translation, 0)
        gesture.ended?(swipe, false)
        XCTAssertEqual(selections, ["b"])
        viewport.update(WorkspacePageConfiguration(pages: [nil, "a", "b"], selection: "b", context: "host", animated: false),
            size: size, content: AnyView(Text("page")), select: { selections.append($0) })
        XCTAssertEqual(viewport.translation, 0)
        XCTAssertTrue(viewport.layer?.animationKeys()?.isEmpty ?? true)
    }

    @MainActor private func layout(_ host: NSView) async {
        host.layoutSubtreeIfNeeded()
        try? await Task.sleep(for: .milliseconds(3))
        host.layoutSubtreeIfNeeded()
    }

    @MainActor private func findGesture(_ view: NSView) -> WorkspaceScrollView? {
        if let gesture = view as? WorkspaceScrollView { return gesture }
        return view.subviews.lazy.compactMap { self.findGesture($0) }.first
    }
    @MainActor private func findViewport(_ view: NSView) -> WorkspacePageViewport? {
        if let viewport = view as? WorkspacePageViewport { return viewport }
        return view.subviews.lazy.compactMap { self.findViewport($0) }.first
    }
}

private final class PagingFixture: ObservableObject {
    @Published var revision = 0
    @Published var selection: String? = "a"
    @Published var context = "host"
    var selections: [String?] = []
    var builds = 0
    var renders = 0
    var renderedRevisions: Set<Int> = []
    var renderedLocales: Set<String> = []
    var renderedRowPages: Set<String> = []

    func select(_ id: String?) { selections.append(id); selection = id }

    func page(_ id: String?) -> PagingProbe {
        builds += 1
        return PagingProbe(fixture: self, revision: revision, name: id ?? "all")
    }
}

private struct PagingFixtureView: View {
    @ObservedObject var fixture: PagingFixture
    var body: some View {
        TaskWorkspacePages(pages: [nil, "a", "b"], selection: fixture.selection, context: fixture.context, select: fixture.select) { id in
            fixture.page(id)
        }
        .environment(\.scenePhase, .active)
        .environment(\.locale, Locale(identifier: "en"))
    }
}

private struct PagingProbe: View {
    let fixture: PagingFixture
    let revision: Int
    let name: String
    @Environment(\.locale) private var locale
    var body: some View {
        fixture.renders += 1
        fixture.renderedRevisions.insert(revision)
        fixture.renderedLocales.insert(locale.identifier)
        return ScrollView {
            LazyVStack { PagingRowProbe(fixture: fixture, name: name, revision: revision) }
        }
    }
}

private struct PagingRowProbe: View {
    let fixture: PagingFixture
    let name: String
    let revision: Int
    var body: some View {
        fixture.renderedRowPages.insert(name)
        return Text("\(name) \(revision)")
    }
}
#endif
