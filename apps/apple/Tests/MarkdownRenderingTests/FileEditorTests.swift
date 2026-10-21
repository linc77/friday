import XCTest
@testable import FridayKit

private actor EditorMemoryCache: FileEditorDraftCaching {
    var values: [String: FileEditorDraft] = [:]
    func load(_ key: String) -> FileEditorDraft? { values[key] }
    func save(_ value: FileEditorDraft, key: String) { values[key] = value }
    func clear(_ key: String, editorId: String, through revision: Int) {
        if let value = values[key], value.editorId == editorId, value.revision <= revision { values[key] = nil }
    }
}

@MainActor private final class EditorHost {
    var document = FileEditorTests.document()
    var requests: [FileSaveAttempt] = []
    var editors: [String] = []
    var workspaces: [String] = []
    var statuses: [String] = []
    var automatic = true, allowed = true
    var outcome = "saved", statusOutcome = "missing"
    var active = 0, maximumActive = 0
    var waiting: [String: CheckedContinuation<FileSaveReply, Error>] = [:]
    var transport: FileEditorTransport {
        FileEditorTransport(save: { [self] attempt, editor, workspace in
            requests.append(attempt); editors.append(editor); workspaces.append(workspace); active += 1; maximumActive = max(maximumActive, active)
            defer { active -= 1 }
            if automatic { return reply(attempt, outcome: outcome) }
            return try await withCheckedThrowingContinuation { waiting[attempt.id] = $0 }
        }, status: { [self] id in
            statuses.append(id)
            return FileSaveReply(status: statusOutcome, requestId: id, version: statusOutcome == "saved" ? "confirmed" : nil, workspaceVersion: document.workspaceVersion, error: statusOutcome == "unconfirmed" ? "保存结果待确认，编辑内容已保留" : nil)
        }, read: { [self] in document }, canPersist: { [self] in allowed })
    }
    func reply(_ attempt: FileSaveAttempt, outcome: String) -> FileSaveReply {
        if outcome == "saved" { document = document.saved(contents: attempt.contents, version: "saved-\(attempt.revision)") }
        return FileSaveReply(status: outcome, requestId: attempt.id, version: outcome == "saved" ? document.version : nil, workspaceVersion: document.workspaceVersion, error: outcome == "saved" ? nil : "保存结果待确认，编辑内容已保留")
    }
    func finish(_ index: Int, outcome: String = "saved") {
        let attempt = requests[index], completion = waiting.removeValue(forKey: attempt.id)
        completion?.resume(returning: reply(attempt, outcome: outcome))
    }
}

final class FileEditorTests: XCTestCase {
    static func document(_ contents: String = "original", workspace: String = String(repeating: "a", count: 64), writable: Bool = true) -> TaskFileDocument {
        TaskFileDocument(path: "src/file.swift", kind: "code", language: "swift", mimeType: "text/plain", sizeBytes: contents.utf8.count, version: "initial", truncated: false, contents: contents, workspaceVersion: workspace, writeSupported: writable)
    }
    @MainActor private func waitUntil(_ predicate: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !predicate(), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(predicate(), file: file, line: line)
    }
    @MainActor func testDefault500MillisecondDebounceWritesOnlyTheLatestContents() async {
        let host = EditorHost(), cache = EditorMemoryCache()
        let session = FileEditSession(key: "file", document: host.document, draft: nil, transport: host.transport, cache: cache)
        session.change("first"); try? await Task.sleep(for: .milliseconds(100)); session.change("latest")
        try? await Task.sleep(for: .milliseconds(300)); XCTAssertTrue(host.requests.isEmpty)
        await waitUntil { !session.isDirty }
        XCTAssertEqual(host.requests.map(\.contents), ["latest"]); XCTAssertEqual(session.document.contents, "latest")
        let draft = await cache.load("file"); XCTAssertNil(draft)
    }
    @MainActor func testClosingDuringSaveFlushesTrailingEditsWithoutOverlappingRequests() async {
        let host = EditorHost(), cache = EditorMemoryCache(); host.automatic = false
        let session = FileEditSession(key: "file", document: host.document, draft: nil, transport: host.transport, cache: cache, debounce: 0.02)
        session.change("first"); session.flush(); await waitUntil { host.requests.count == 1 }
        session.change("second"); session.flush(); try? await Task.sleep(for: .milliseconds(60))
        XCTAssertEqual(host.requests.count, 1); host.finish(0)
        await waitUntil { host.requests.count == 2 }; XCTAssertTrue(session.isDirty); XCTAssertEqual(session.contents, "second")
        XCTAssertEqual(host.requests.map(\.contents), ["first", "second"]); XCTAssertEqual(host.maximumActive, 1)
        host.finish(1); await waitUntil { !session.isDirty && !session.isSaving }
        XCTAssertEqual(session.document.contents, "second"); let draft = await cache.load("file"); XCTAssertNil(draft)
    }
    @MainActor func testAnUnconfirmedSaveSurvivesRemountAndIsReconciledWithoutAnotherWrite() async throws {
        let host = EditorHost(), cache = EditorMemoryCache(); host.outcome = "unconfirmed"
        let session = FileEditSession(key: "file", document: host.document, draft: nil, transport: host.transport, cache: cache, debounce: 0.02)
        session.change("keep this"); session.flush(); await waitUntil { session.error != nil && !session.isSaving }
        let stored = await cache.load("file"), draft = try XCTUnwrap(stored)
        XCTAssertEqual(draft.contents, "keep this"); XCTAssertNotNil(draft.pending)
        try? await Task.sleep(for: .milliseconds(80)); XCTAssertEqual(host.requests.count, 1)
        host.statusOutcome = "saved"; host.document = Self.document("keep this")
        let restored = FileEditSession(key: "file", document: host.document, draft: draft, transport: host.transport, cache: cache, debounce: 0.02)
        restored.resume(); await waitUntil { !restored.isDirty && !restored.isSaving }
        XCTAssertEqual(host.requests.count, 1); XCTAssertEqual(host.statuses, [draft.pending!.id]); XCTAssertEqual(restored.contents, "keep this")
    }
    @MainActor func testMissingReceiptResendsTheSameRequestAndRestoredEditorIdentity() async {
        let host = EditorHost(), cache = EditorMemoryCache(), attempt = FileSaveAttempt(id: "known-request", revision: 3, contents: "restored")
        let draft = FileEditorDraft(editorId: "known-editor", revision: 3, confirmedRevision: 2, stamp: 4, contents: "restored", workspaceVersion: host.document.workspaceVersion!, pending: attempt)
        let session = FileEditSession(key: "file", document: host.document, draft: draft, transport: host.transport, cache: cache, debounce: 0.02)
        session.resume(); await waitUntil { !session.isDirty && !session.isSaving }
        XCTAssertEqual(host.statuses, ["known-request"]); XCTAssertEqual(host.requests, [attempt]); XCTAssertEqual(host.editors, ["known-editor"])
    }
    @MainActor func testWorkspaceReplacementKeepsEditsAndRejectsTheOldSuccess() async {
        let host = EditorHost(), cache = EditorMemoryCache(); host.automatic = false
        let session = FileEditSession(key: "file", document: host.document, draft: nil, transport: host.transport, cache: cache, debounce: 0.02)
        session.change("my work"); session.flush(); await waitUntil { host.requests.count == 1 }
        session.accept(Self.document("replacement", workspace: String(repeating: "b", count: 64)), readRevision: session.revision)
        host.finish(0); await waitUntil { !session.isSaving }
        XCTAssertTrue(session.isDirty); XCTAssertFalse(session.rootMatches); XCTAssertEqual(session.contents, "my work"); XCTAssertNotNil(session.error)
        session.flush(); try? await Task.sleep(for: .milliseconds(50)); XCTAssertEqual(host.requests.count, 1)
        let oldEditor = session.editorId; await session.readReplacedWorkspace()
        XCTAssertEqual(session.contents, "replacement"); XCTAssertFalse(session.isDirty); XCTAssertTrue(session.rootMatches); XCTAssertNotEqual(session.editorId, oldEditor)
    }
    @MainActor func testOlderReadCannotReplaceAConfirmedNewerEdit() async {
        let host = EditorHost(), cache = EditorMemoryCache(), old = Self.document()
        let session = FileEditSession(key: "file", document: old, draft: nil, transport: host.transport, cache: cache, debounce: 0.02)
        session.change("newest"); let readingWhileDirty = session.revisionForRead; XCTAssertNil(readingWhileDirty)
        session.flush(); await waitUntil { !session.isDirty && !session.isSaving }
        session.accept(old, readRevision: 0); XCTAssertEqual(session.contents, "newest"); XCTAssertEqual(session.document.contents, "newest")
        session.accept(old, readRevision: readingWhileDirty); XCTAssertEqual(session.contents, "newest")
    }
    @MainActor func testReadOnlyHostAndRevokedWriteCapabilityNeverSendWrites() async {
        let host = EditorHost(), cache = EditorMemoryCache(); host.allowed = false
        let session = FileEditSession(key: "file", document: host.document, draft: nil, transport: host.transport, cache: cache, debounce: 0.02)
        session.change("held"); session.flush(); try? await Task.sleep(for: .milliseconds(60))
        XCTAssertTrue(host.requests.isEmpty); let draft = await cache.load("file"); XCTAssertEqual(draft?.contents, "held")
        let legacy = FileEditSession(key: "legacy", document: Self.document(writable: false), draft: nil, transport: host.transport, cache: cache, debounce: 0.02)
        legacy.change("ignored"); legacy.flush(); XCTAssertFalse(legacy.canEdit); XCTAssertFalse(legacy.isDirty); XCTAssertEqual(legacy.contents, "original")
    }
    @MainActor func testExplicitRetryUsesANewerRevisionAndNewRequest() async {
        let host = EditorHost(), cache = EditorMemoryCache(); host.outcome = "unconfirmed"
        let session = FileEditSession(key: "file", document: host.document, draft: nil, transport: host.transport, cache: cache, debounce: 0.02)
        session.change("mine"); session.flush(); await waitUntil { session.error != nil && !session.isSaving }
        host.outcome = "saved"; session.retry(); await waitUntil { !session.isDirty && !session.isSaving }
        XCTAssertEqual(host.requests.count, 2); XCTAssertNotEqual(host.requests[0].id, host.requests[1].id)
        XCTAssertGreaterThan(host.requests[1].revision, host.requests[0].revision); XCTAssertEqual(host.requests[1].contents, "mine")
    }
    @MainActor func testNewEditsDuringAnUnconfirmedSaveStillSaveTheirLatestRevision() async {
        let host = EditorHost(), cache = EditorMemoryCache(); host.automatic = false
        let session = FileEditSession(key: "file", document: host.document, draft: nil, transport: host.transport, cache: cache, debounce: 0.02)
        session.change("old"); session.flush(); await waitUntil { host.requests.count == 1 }
        session.change("new"); host.finish(0, outcome: "unconfirmed")
        await waitUntil { host.requests.count == 2 }; XCTAssertEqual(host.requests[1].contents, "new"); XCTAssertGreaterThan(host.requests[1].revision, host.requests[0].revision)
        host.finish(1); await waitUntil { !session.isDirty && !session.isSaving }; XCTAssertEqual(session.contents, "new")
    }
    @MainActor func testAReceiptFromADifferentRequestCannotConfirmTheCurrentBuffer() async {
        let cache = EditorMemoryCache(), document = Self.document()
        let transport = FileEditorTransport(save: { _, _, _ in FileSaveReply(status: "saved", requestId: "different", version: "old", workspaceVersion: document.workspaceVersion) }, status: { id in FileSaveReply(status: "missing", requestId: id) }, read: { document }, canPersist: { true })
        let session = FileEditSession(key: "file", document: document, draft: nil, transport: transport, cache: cache, debounce: 0.02)
        session.change("current"); session.flush(); await waitUntil { session.error != nil && !session.isSaving }
        XCTAssertTrue(session.isDirty); XCTAssertEqual(session.document.contents, "original"); XCTAssertEqual(session.contents, "current")
    }
    @MainActor func testMarkdownTaskWritesRequireTheSourceThatProducedTheirOffsets() {
        let host = EditorHost(), source = "- [ ] first\n- [ ] second\n"; host.allowed = false
        let session = FileEditSession(key: "file", document: Self.document(source), draft: nil, transport: host.transport, cache: EditorMemoryCache(), debounce: 0.02)
        let inserted = "- [ ] inserted\n" + source
        session.change(inserted); let revision = session.revision
        session.setTaskChecked(at: 2, checked: true, source: source)
        XCTAssertEqual(session.contents, inserted); XCTAssertEqual(session.revision, revision, "A stale render must not check the different task now occupying the old marker")
        session.setTaskChecked(at: 2, checked: true, source: inserted)
        XCTAssertEqual(session.contents, "- [x] inserted\n" + source); XCTAssertEqual(session.revision, revision + 1)
    }
    @MainActor func testSharedStoreKeepsDirtyContentsAcrossEditorsAndScopesThemToTheAccountAndWorkspace() async {
        let host = EditorHost(), editors = FileEditorStore(cache: EditorMemoryCache()); host.allowed = false
        let key = FileEditorStore.key(server: "https://host.test", token: "private-token", cwd: "/project", path: "src/file.swift")
        XCTAssertEqual(key.count, 64); XCTAssertFalse(key.contains("private"))
        let first = await editors.open(key: key, document: host.document, transport: host.transport, readRevision: nil)
        first.change("still editing")
        let reopened = await editors.open(key: key, document: host.document, transport: host.transport, readRevision: 0)
        XCTAssertTrue(first === reopened); XCTAssertEqual(reopened.contents, "still editing")
        for changed in [FileEditorStore.key(server: "https://other.test", token: "private-token", cwd: "/project", path: "src/file.swift"), FileEditorStore.key(server: "https://host.test", token: "other", cwd: "/project", path: "src/file.swift"), FileEditorStore.key(server: "https://host.test", token: "private-token", cwd: "/elsewhere", path: "src/file.swift")] { XCTAssertNotEqual(key, changed) }
    }
    func testPrivateDraftCacheOrdersSnapshotsAndDoesNotResurrectAcknowledgedEdits() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Friday-FileEdits-" + UUID().uuidString), key = String(repeating: "a", count: 64)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = FileEditorDraftCache(directory: root)
        func draft(_ stamp: Int, revision: Int = 2) -> FileEditorDraft { FileEditorDraft(editorId: "editor", revision: revision, confirmedRevision: 0, stamp: stamp, contents: "private \(stamp)", workspaceVersion: "workspace", pending: nil) }
        await cache.save(draft(3), key: key); await cache.save(draft(2), key: key)
        let loaded = await cache.load(key); XCTAssertEqual(loaded?.contents, "private 3")
        let directoryMode = try FileManager.default.attributesOfItem(atPath: root.path)[.posixPermissions] as? NSNumber
        let fileMode = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent(key + ".json").path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(directoryMode?.intValue, 0o700); XCTAssertEqual(fileMode?.intValue, 0o600)
        await cache.clear(key, editorId: "other-editor", through: 99); let retained = await cache.load(key); XCTAssertNotNil(retained)
        await cache.clear(key, editorId: "editor", through: 2); await cache.save(draft(99), key: key)
        let cleared = await cache.load(key); XCTAssertNil(cleared)
        await cache.save(draft(100, revision: 3), key: key); let newer = await cache.load(key); XCTAssertEqual(newer?.revision, 3)
    }
}
