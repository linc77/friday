import XCTest
@testable import FridayKit

private actor EditorGate<Value: Sendable> {
    private var continuation: CheckedContinuation<Value, Never>?
    private var value: Value?
    private var entered = false
    private var starters: [CheckedContinuation<Void, Never>] = []
    func wait() async -> Value {
        entered = true; starters.forEach { $0.resume() }; starters = []
        if let value { return value }
        return await withCheckedContinuation { continuation = $0 }
    }
    func started() async { if !entered { await withCheckedContinuation { starters.append($0) } } }
    func release(_ value: Value) { self.value = value; continuation?.resume(returning: value); continuation = nil }
}
@MainActor final class HostEditorTests: XCTestCase {
    private func snapshot(_ root: String, _ id: String = "vscode") -> TaskHostEditorSnapshot {
        TaskHostEditorSnapshot(workspaceRoot: root, platform: "darwin", revealSupported: true, editors: [TaskHostEditor(id: id, label: id)])
    }
    func testUnavailablePreferredEditorFallsBackToTheFirstInstalledEditorWithoutInventingAnOption() {
        let editors = [TaskHostEditor(id: "cursor", label: "Cursor"), TaskHostEditor(id: "vscode", label: "VS Code"), TaskHostEditor(id: "file-manager", label: "Finder")]
        XCTAssertEqual(TaskHostEditor.preferred("vscode", in: editors)?.id, "vscode")
        XCTAssertEqual(TaskHostEditor.preferred("missing", in: editors)?.id, "cursor")
        XCTAssertEqual(TaskHostEditor.preferred("", in: Array(editors.suffix(1)))?.id, "file-manager")
        XCTAssertNil(TaskHostEditor.preferred("vscode", in: []))
    }
    func testAnOldDiscoveryReplyCannotReplaceTheNewConnectionOrWorkspace() async {
        let model = TaskHostEditorModel(), gate = EditorGate<TaskHostEditorSnapshot>()
        let old = Task { await model.load(identity: "old", root: "/old", transport: TaskHostEditorTransport(load: { await gate.wait() }, open: { _ in })) }
        await gate.started()
        let latest = snapshot("/new", "cursor")
        await model.load(identity: "new", root: "/new", transport: TaskHostEditorTransport(load: { latest }, open: { _ in }))
        await gate.release(snapshot("/old")); await old.value
        XCTAssertEqual(model.snapshot?.workspaceRoot, "/new")
        XCTAssertEqual(model.snapshot?.editors.first?.id, "cursor")
        XCTAssertFalse(model.loading)
    }
    func testOpeningFreezesItsTransportRejectsDuplicateClicksAndDoesNotReportAnOldFailureInANewScope() async throws {
        let model = TaskHostEditorModel(), gate = EditorGate<Bool>(), original = snapshot("/old")
        await model.load(identity: "old", root: "/old", transport: TaskHostEditorTransport(load: { original }, open: { action in
            XCTAssertEqual(action.path, "file #?% $(literal):12.txt"); XCTAssertEqual(action.line, 12)
            _ = await gate.wait(); throw ConnectionError.message("old failure")
        }))
        let action = TaskHostEditorAction(path: "file #?% $(literal):12.txt", editor: "vscode", line: 12)
        let pending = try XCTUnwrap(model.open(action, identity: "old"))
        await gate.started(); XCTAssertTrue(model.busy); XCTAssertNil(model.open(action, identity: "old"))
        let latest = snapshot("/new", "cursor")
        await model.load(identity: "new", root: "/new", transport: TaskHostEditorTransport(load: { latest }, open: { _ in XCTFail("Old action reached new transport") }))
        XCTAssertNil(model.open(action, identity: "old"))
        await gate.release(true); await pending.value
        XCTAssertEqual(model.snapshot?.workspaceRoot, "/new"); XCTAssertNil(model.error); XCTAssertFalse(model.busy)
    }
    func testMismatchedWorkspaceResponseCannotEnableAnOpenAction() async {
        let model = TaskHostEditorModel(), wrong = snapshot("/other")
        await model.load(identity: "scope", root: "/expected", transport: TaskHostEditorTransport(load: { wrong }, open: { _ in XCTFail("Mismatched root opened") }))
        XCTAssertNil(model.snapshot); XCTAssertNotNil(model.error)
        XCTAssertNil(model.open(TaskHostEditorAction(path: "", editor: "vscode"), identity: "scope"))
    }
}
