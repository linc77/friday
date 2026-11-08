import XCTest
import Observation
import SwiftUI
@testable import FridayKit
#if os(macOS)
import AppKit

final class FridayRenderingTests: XCTestCase {
    private final class Changes: @unchecked Sendable { var count = 0 }
    @MainActor @Observable fileprivate final class ViewportData { var text = "first" }

    @MainActor func testWidthReflowsWithoutRebuildingTranscriptContent() async {
        let renders = Changes(), data = ViewportData()
        let root = NSHostingView(rootView: TranscriptViewport { metrics in
            let _ = { renders.count += 1 }()
            Text(data.text + String(describing: metrics.height)).frame(maxWidth: .infinity, maxHeight: .infinity)
        })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = root
        defer { window.contentView = nil }
        func settle() async { for _ in 0..<8 { root.layoutSubtreeIfNeeded(); await Task.yield() } }
        await settle()
        let initial = renders.count
        XCTAssertGreaterThan(initial, 0)
        for width in stride(from: 800, through: 700, by: -10) {
            window.setContentSize(CGSize(width: width, height: 600)); await settle()
        }
        XCTAssertEqual(root.bounds.width, 700, accuracy: 1)
        XCTAssertEqual(renders.count, initial, "Width must only reflow the existing content graph")
        window.setContentSize(CGSize(width: 700, height: 650)); await settle()
        XCTAssertGreaterThan(renders.count, initial, "Viewport height is still a live input")
        let resized = renders.count
        data.text = "new message"; await settle()
        XCTAssertGreaterThan(renders.count, resized, "Data updates must not be masked by the geometry boundary")
    }

    @MainActor func testStoreTracksFieldsAndTaskIDsInsteadOfAllPublications() throws {
        let store = FridayStore(loadLocalState: false)
        let snapshot = try decode(Snapshot.self, ["revision": 1, "ideas": [], "projects": [], "memories": [],
            "tasks": [body("a"), body("b")], "taskStreamSession": "service", "taskStreamSerial": 1])
        store.apply(snapshot)
        let scope = store.connectionIdentity
        XCTAssertTrue(store.applyTaskDetail(try frame("a", serial: 1), for: "a", scope: scope))
        XCTAssertTrue(store.applyTaskDetail(try frame("b", serial: 1), for: "b", scope: scope))
        let taskA = Changes(), ideas = Changes(), sidebar = Changes()
        withObservationTracking { _ = store.taskDetail("a") } onChange: { taskA.count += 1 }
        withObservationTracking { _ = store.ideas } onChange: { ideas.count += 1 }
        withObservationTracking { _ = store.tasks } onChange: { sidebar.count += 1 }
        XCTAssertTrue(store.applyTaskDetail(try frame("b", serial: 2), for: "b", scope: scope))
        XCTAssertEqual(taskA.count, 0)
        XCTAssertEqual(ideas.count, 0)
        XCTAssertEqual(sidebar.count, 0, "A streamed body must not invalidate the overview")
        let patch = try decode(TaskSummaryPatch.self, ["sessionId": "service", "sequence": 2, "serial": 3,
            "tasks": [body("b")], "removed": []])
        XCTAssertTrue(store.applyTaskSummaryPatch(patch, scope: scope))
        XCTAssertEqual(taskA.count, 0, "Another task's summary must not invalidate this detail")
        XCTAssertEqual(sidebar.count, 1)
        XCTAssertEqual(ideas.count, 0)
        XCTAssertTrue(store.applyTaskDetail(try frame("a", serial: 4), for: "a", scope: scope))
        XCTAssertEqual(taskA.count, 1)
        let duplicate = Changes()
        withObservationTracking { _ = store.taskDetail("a") } onChange: { duplicate.count += 1 }
        XCTAssertFalse(store.applyTaskDetail(try frame("a", serial: 4), for: "a", scope: scope))
        XCTAssertEqual(duplicate.count, 0)
        let removal = try decode(TaskSummaryPatch.self, ["sessionId": "service", "sequence": 3, "serial": 5,
            "tasks": [], "removed": ["a"]])
        XCTAssertTrue(store.applyTaskSummaryPatch(removal, scope: scope))
        XCTAssertEqual(duplicate.count, 1)
        XCTAssertNil(store.taskDetail("a"), "Removal cannot leave a retained body visible")
    }

    @MainActor func testProjectionRebuildsOffMainForDataAndHostChangesOnly() async throws {
        let projection = TaskTranscriptProjection()
        var task = try decode(WorkItem.self, body("a", omitted: false))
        let key = TaskTranscriptProjection.Key(scope: "host-a/task-a", revision: 1, history: 1, conversation: 1)
        func input(_ task: WorkItem) -> TaskTranscriptProjection.Input {
            .init(task: task, history: TaskHistoryWindow(), conversation: TaskConversationWindow(), scope: key.scope)
        }
        for _ in 0..<120 { projection.update(key, input: input(task)); await projection.waitForPendingUpdates() }
        XCTAssertEqual(projection.builds, 1, "Layout and composer changes cannot regenerate the same data")
        XCTAssertEqual(projection.lastBuildOnMainThread, false)
        var updated = body("a", omitted: false); updated["result"] = "new result"
        task = try decode(WorkItem.self, updated)
        let changed = TaskTranscriptProjection.Key(scope: key.scope, revision: 2, history: 1, conversation: 1)
        projection.update(changed, input: input(task)); await projection.waitForPendingUpdates()
        XCTAssertEqual(projection.presentation(in: key.scope)?.task.result, "new result")
        XCTAssertEqual(projection.builds, 2)
        XCTAssertNil(projection.presentation(in: "host-b/task-a"), "Never display another host's snapshot while preparing new rows")
        let cancelled = Task { projection.update(.init(scope: key.scope, revision: 3, history: 1, conversation: 1), input: input(task)) }
        cancelled.cancel(); await cancelled.value
        XCTAssertEqual(projection.builds, 2, "A superseded job cannot publish a result")
        let removed = TaskTranscriptProjection.Key(scope: key.scope, revision: 4, history: 1, conversation: 1)
        projection.update(removed, input: nil); await projection.waitForPendingUpdates()
        XCTAssertNil(projection.presentation(in: key.scope), "Removal cannot leave a retained presentation")
    }

    @MainActor func testRapidStreamUpdatesCoalesceAndPublishTheLatestSnapshot() async throws {
        let projection = TaskTranscriptProjection()
        let scope = "host/task"
        for revision in 0..<100 {
            var json = body("a", omitted: false); json["result"] = "revision-\(revision)"
            let task = try decode(WorkItem.self, json)
            projection.update(.init(scope: scope, revision: revision, history: 0, conversation: 0),
                input: .init(task: task, history: TaskHistoryWindow(), conversation: TaskConversationWindow(), scope: scope))
        }
        await projection.waitForPendingUpdates()
        XCTAssertEqual(projection.presentation(in: scope)?.task.result, "revision-99")
        XCTAssertLessThanOrEqual(projection.builds, 2, "A burst must not queue a render for every frame")
        let task = try decode(WorkItem.self, body("a", omitted: false))
        projection.update(.init(scope: scope, revision: 100, history: 0, conversation: 0),
            input: .init(task: task, history: TaskHistoryWindow(), conversation: TaskConversationWindow(), scope: scope))
        projection.update(.init(scope: scope, revision: 101, history: 0, conversation: 0), input: nil)
        for _ in 0..<4 { await Task.yield() }
        XCTAssertNil(projection.presentation(in: scope), "Pending work cannot resurrect a removed task")
    }

    @MainActor func testSplitViewFillsItsSwiftUIViewport() async throws {
        let root = NSHostingView(rootView: FridayRetainedPages(selection: "task", scope: "host") {
            TaskPanelSplitView(width: .constant(460), visible: true,
                main: Text(String(repeating: "conversation ", count: 400)), panel: { Text("diff") })
        })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 600),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = root
        defer { window.contentView = nil }
        for _ in 0..<4 { root.layoutSubtreeIfNeeded(); await Task.yield() }
        func split(in view: NSView) -> TaskPanelSplitHost? {
            (view as? TaskPanelSplitHost) ?? view.subviews.lazy.compactMap { split(in: $0) }.first
        }
        let host = try XCTUnwrap(split(in: root))
        XCTAssertEqual(host.bounds.width, 1200, accuracy: 1)
        XCTAssertEqual(host.bounds.height, 600, accuracy: 1)
        XCTAssertEqual(host.subviews.count, 3)
        for size in [CGSize(width: 980, height: 740), CGSize(width: 1450, height: 820), CGSize(width: 1200, height: 600)] {
            window.setContentSize(size)
            for _ in 0..<4 { root.layoutSubtreeIfNeeded(); await Task.yield() }
            XCTAssertEqual(host.bounds.width, size.width, accuracy: 1, "Document ideal size cannot constrain the viewport")
            XCTAssertEqual(host.bounds.height, size.height, accuracy: 1)
            XCTAssertEqual(host.displayedWidth, 460, accuracy: 1)
        }
    }

    @MainActor func testContinuousResizeCommitsOnceAndCancellationRestoresWidth() {
        let split = TaskPanelSplitHost()
        split.frame = NSRect(x: 0, y: 0, width: 1200, height: 600)
        var commits: [Double] = []
        split.update(width: 460, visible: true, main: AnyView(Text("main")), panel: AnyView(Text("panel")), commit: { commits.append($0) })
        split.layoutSubtreeIfNeeded()
        split.beginResize(at: 700)
        for x in stride(from: 699, through: 580, by: -1) {
            split.resize(to: CGFloat(x)); split.layoutSubtreeIfNeeded()
        }
        XCTAssertTrue(commits.isEmpty, "Pointer motion cannot publish page state or save preferences")
        XCTAssertEqual(split.displayedWidth, 580)
        split.finishResize()
        XCTAssertEqual(commits, [580])
        split.beginResize(at: 580); split.resize(to: 480); split.finishResize(cancelled: true)
        XCTAssertEqual(split.displayedWidth, 580)
        XCTAssertEqual(commits, [580])
        split.adjust(by: 40)
        XCTAssertEqual(commits, [580, 620], "Accessibility adjustment uses the same committed width")
        for total in [0.0, 200, 600, 1200] {
            let width = TaskPanelSplitHost.clamped(.infinity, total: total)
            XCTAssertTrue(width.isFinite)
            XCTAssertGreaterThanOrEqual(width, 0)
            XCTAssertLessThanOrEqual(width, total)
        }
    }

    @MainActor func testEmptyAnnotationResizeDoesNotIndexOrInvalidateTheDocument() {
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        text.textContainer?.widthTracksTextView = false
        text.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.string = String(repeating: "a source line\n", count: 10_000)
        let annotations = TaskSourceAnnotations()
        annotations.attach(text)
        for width in 400..<520 {
            text.frame.size.width = CGFloat(width)
            annotations.update([], locale: Locale(identifier: "en"), dark: false, submit: { _, _ in }, remove: { _ in })
            annotations.position()
        }
        XCTAssertEqual(annotations.lineIndexBuilds, 0)
        XCTAssertTrue(annotations.reservedHeights.isEmpty)
        XCTAssertEqual(annotations.contentHeight, 0)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: [String: Any]) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
    private func body(_ id: String, omitted: Bool = true) -> [String: Any] {
        ["id": id, "title": id, "prompt": "", "projectId": NSNull(), "cwd": "/project", "agent": "codex", "mode": "code", "status": "completed", "createdAt": "", "updatedAt": "", "durableId": NSNull(), "threadId": NSNull(), "turnId": NSNull(), "result": "body", "events": [], "approvals": [], "artifact": NSNull(), "contentOmitted": omitted, "contentVersion": "v1", "contentSequence": 1]
    }
    private func frame(_ id: String, serial: Int) throws -> TaskDetailSnapshot {
        try decode(TaskDetailSnapshot.self, ["taskId": id, "sessionId": "service", "sequence": 2, "serial": serial,
            "version": "v1", "task": body(id, omitted: false)])
    }
}
#endif
