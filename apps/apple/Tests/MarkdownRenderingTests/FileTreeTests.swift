import XCTest
@testable import FridayKit

final class FileTreeTests: XCTestCase {
    private func entry(_ path: String, _ kind: String = "file") -> TaskFileEntry { TaskFileEntry(path: path, name: String(path.split(separator: "/").last ?? ""), kind: kind) }
    private func reference(_ id: String, path: String? = nil, digest: String? = nil) -> TaskContextReference {
        TaskContextReference(id: id, kind: "file", label: path ?? id, capturedAt: "2026-10-19T00:00:00Z", digest: digest ?? id, byteLength: 12, path: path ?? id, terminalId: nil, terminalLabel: nil, generation: nil, lineStart: nil, lineEnd: nil, truncated: false)
    }
    func testMentionMarkdownMatchesT3EscapingAndKeepsLiteralPathCharacters() {
        let cases = [
            ("src/a[b].swift", "[a\\[b\\].swift](src/a%5Bb%5D.swift)"),
            ("中文/hello (x)#?.md", "[hello (x)#?.md](%E4%B8%AD%E6%96%87/hello%20%28x%29%23%3F.md)"),
            ("src/a\\b.ts", "[b.ts](src/a%5Cb.ts)"),
            ("O'Reilly/file%20.txt", "[file%20.txt](O'Reilly/file%2520.txt)")]
        for (path, expected) in cases { XCTAssertEqual(TaskFileMention(path: path, kind: "file").markdown, expected) }
    }
    func testTransferScopesTheServiceAccountAndWorkspaceWithoutExportingCredentials() throws {
        let scope = TaskFileMentionPayload.scope(server: "https://host.test", token: "private-account-key", cwd: "/project")
        let payload = TaskFileMentionPayload(scope: scope, entries: [TaskFileMention(entry("src/file.swift"))]), data = try XCTUnwrap(payload.data)
        XCTAssertEqual(TaskFileMentionPayload.decode(data), payload)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("private-account-key")); XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("https://host.test"))
        for changed in [TaskFileMentionPayload.scope(server: "https://other.test", token: "private-account-key", cwd: "/project"), TaskFileMentionPayload.scope(server: "https://host.test", token: "other", cwd: "/project"), TaskFileMentionPayload.scope(server: "https://host.test", token: "private-account-key", cwd: "/different")] { XCTAssertNotEqual(changed, scope) }
    }
    func testPairedDevicesAndDifferentURLsUseTheSameAuthenticatedHostScope() {
        let service = String(repeating: "a", count: 64)
        let mac = TaskFileMentionPayload.scope(server: "http://127.0.0.1:14317", token: "owner", cwd: "/project", serviceId: service)
        let phone = TaskFileMentionPayload.scope(server: "https://host.tailnet.test", token: "phone-device", cwd: "/project", serviceId: service)
        XCTAssertEqual(mac, phone)
        XCTAssertNotEqual(mac, TaskFileMentionPayload.scope(server: "http://127.0.0.1:14317", token: "owner", cwd: "/project", serviceId: String(repeating: "b", count: 64)))
        XCTAssertNotEqual(mac, TaskFileMentionPayload.scope(server: "http://127.0.0.1:14317", token: "owner", cwd: "/other", serviceId: service))
    }
    func testHostIdentityDoesNotCarryAcrossConnectionsOrAnOlderHostResponse() {
        var identity = TaskServiceIdentity(); let service = String(repeating: "a", count: 64)
        identity.observe(service, connection: "first", authoritative: true); XCTAssertEqual(identity.value(for: "first"), service)
        XCTAssertNil(identity.value(for: "second"))
        identity.observe(nil, connection: "first", authoritative: false); XCTAssertEqual(identity.value(for: "first"), service)
        identity.observe(nil, connection: "second", authoritative: false); XCTAssertNil(identity.value(for: "second"))
        identity.observe(service, connection: "second", authoritative: true)
        identity.observe(nil, connection: "second", authoritative: true); XCTAssertNil(identity.value(for: "second"))
        identity.observe("not-a-host-id", connection: "second", authoritative: true); XCTAssertNil(identity.value(for: "second"))
    }
    func testMalformedCrossScopeAndOversizedPayloadsNeverBecomeReferences() throws {
        let scope = String(repeating: "a", count: 64)
        for path in ["", "//etc/passwd", "../outside", "src/../file", "src//file", ".git/config", "src/.GIT/HEAD", "src/\0name"] {
            let payload = TaskFileMentionPayload(scope: scope, entries: [TaskFileMention(path: path, kind: "file")]); XCTAssertNil(TaskFileMentionPayload.decode(try XCTUnwrap(payload.data)), path)
        }
        let payload = TaskFileMentionPayload(scope: scope, entries: [TaskFileMention(entry("one"))])
        XCTAssertNil(TaskFileMentionPayload.combine([payload, TaskFileMentionPayload(scope: String(repeating: "b", count: 64), entries: payload.entries)]))
        XCTAssertNil(TaskFileMentionPayload.decode(try XCTUnwrap(TaskFileMentionPayload(version: 2, scope: scope, entries: payload.entries).data)))
        XCTAssertNil(TaskFileMentionPayload.decode(Data(repeating: 32, count: 128 * 1024 + 1)))
        XCTAssertNil(TaskFileMentionPayload.decode(try XCTUnwrap(TaskFileMentionPayload(scope: scope, entries: (0..<21).map { TaskFileMention(entry("file\($0)")) }).data)))
        let literal = TaskFileMentionPayload(scope: scope, entries: [TaskFileMention(entry("src/first\nsecond.txt"))])
        XCTAssertEqual(TaskFileMentionPayload.decode(try XCTUnwrap(literal.data)), literal, "Literal filenames accepted by the host remain usable as references")
    }
    func testMultiRowDropsKeepOrderAndMentionDirectoriesOnlyOnce() {
        let scope = String(repeating: "a", count: 64), first = TaskFileMention(entry("docs", "directory")), second = TaskFileMention(entry("src/one.swift"))
        let combined = TaskFileMentionPayload.combine([TaskFileMentionPayload(scope: scope, entries: [first, second]), TaskFileMentionPayload(scope: scope, entries: [first])])
        XCTAssertEqual(combined?.entries, [first, second]); XCTAssertEqual(combined?.markdown, "[docs](docs) [one.swift](src/one.swift)")
    }
    @MainActor func testRecipientRejectsStaleDisabledAndUnreadyEditorsBeforeInsertion() throws {
        let scope = String(repeating: "a", count: 64), payload = TaskFileMentionPayload(scope: scope, entries: [TaskFileMention(entry("file"))]), data = try XCTUnwrap(payload.data)
        var inserted = 0
        XCTAssertFalse(TaskFileMentionContext(scope: "different", enabled: true, insert: { _ in inserted += 1; return true }).receive(data))
        XCTAssertFalse(TaskFileMentionContext(scope: scope, enabled: false, insert: { _ in inserted += 1; return true }).receive(data))
        XCTAssertFalse(TaskFileMentionContext(scope: scope, enabled: true, insert: { _ in false }).receive(data)); XCTAssertEqual(inserted, 0)
        XCTAssertTrue(TaskFileMentionContext(scope: scope, enabled: true, insert: { _ in inserted += 1; return true }).receive(data)); XCTAssertEqual(inserted, 1)
    }
    @MainActor func testAnOldComposerCannotClearTheNewComposerBridge() {
        let bridge = TaskFileMentionBridge(), old = UUID(), current = UUID()
        bridge.register(TaskFileMentionContext(scope: "old", enabled: true, insert: { _ in true }), owner: old)
        bridge.register(TaskFileMentionContext(scope: "current", enabled: true, insert: { _ in true }), owner: current)
        bridge.clear(owner: old); XCTAssertEqual(bridge.context?.scope, "current")
        bridge.clear(owner: current); XCTAssertNil(bridge.context)
    }
    @MainActor func testNativeDragProviderExportsOnlyTheScopedMentionData() async throws {
        let payload = TaskFileMentionPayload(scope: String(repeating: "a", count: 64), entries: [TaskFileMention(entry("src/file.swift"))])
        let provider = TaskFileMentionTransfer.provider(payload)
        XCTAssertEqual(provider.registeredTypeIdentifiers, [TaskFileMentionTransfer.type])
        let data: Data? = await withCheckedContinuation { continuation in _ = provider.loadDataRepresentation(forTypeIdentifier: TaskFileMentionTransfer.type) { data, _ in continuation.resume(returning: data) } }
        XCTAssertEqual(TaskFileMentionPayload.decode(try XCTUnwrap(data)), payload)
    }
    func testDraggingNeverOpensThePreviewAndClearsTheDraggedSelectionOnEnd() {
        var interaction = TaskFileTreeInteraction(); interaction.beginMouse()
        XCTAssertNil(interaction.select([entry("one"), entry("two")]))
        interaction.beginDrag(); XCTAssertNil(interaction.endMouse()); interaction.endDrag(); XCTAssertTrue(interaction.selected.isEmpty)
        interaction.beginMouse(); XCTAssertNil(interaction.select([entry("three")])); XCTAssertEqual(interaction.endMouse(), "three")
        interaction.beginKeyboard(); XCTAssertEqual(interaction.select([entry("four")]), "four")
        interaction.beginMouse(); XCTAssertNil(interaction.select([entry("four"), entry("folder", "directory")])); XCTAssertNil(interaction.endMouse())
    }
    func testUnchangedSelectionDoesNotReopenTheFileWhenADisclosureIsClicked() {
        var interaction = TaskFileTreeInteraction(); interaction.beginKeyboard(); XCTAssertEqual(interaction.select([entry("selected.swift")]), "selected.swift")
        interaction.beginMouse(); XCTAssertNil(interaction.endMouse(), "Opening a different folder's disclosure leaves the selected file alone")
        interaction.beginMouse(); XCTAssertNil(interaction.select([entry("selected.swift")])); XCTAssertNil(interaction.endMouse())
        interaction.beginMouse(); XCTAssertNil(interaction.select([entry("different.swift")])); XCTAssertEqual(interaction.endMouse(), "different.swift")
    }
    func testRevealingWaitsForLazyAncestorsAndStopsWhenTheUserInteracts() {
        var reveal = TaskFileTreeReveal()
        XCTAssertTrue(reveal.pending("first")); reveal.resolve("first", selected: "src/deep/file", found: false)
        XCTAssertTrue(reveal.pending("first"), "Loading only the root must not consume a reveal for an unloaded descendant")
        reveal.resolve("first", selected: "src/deep/file", found: true); XCTAssertFalse(reveal.pending("first"))
        XCTAssertTrue(reveal.pending("second")); reveal.interacted("second"); XCTAssertFalse(reveal.pending("second"), "A user's tree selection takes priority over an old pending reveal")
        reveal.resolve("empty", selected: nil, found: false); XCTAssertFalse(reveal.pending("empty"))
    }
    func testSearchSynthesizesOnlyTheMatchingAncestorsAndKeepsLoadedTreeSeparate() {
        let projection = TaskFileTreeProjection(entries: ["": [entry("unrelated.txt")]], matches: [entry("src/deep/result.swift")], query: "result")
        XCTAssertTrue(projection.searching); XCTAssertEqual(projection.visible(expanded: projection.directories).map { $0.item.path }, ["src", "src/deep", "src/deep/result.swift"])
        XCTAssertEqual(projection.visible(expanded: projection.directories).map(\.depth), [0, 1, 2]); XCTAssertFalse(projection.roots.contains { $0.path == "unrelated.txt" })
    }
    func testSearchKeepsManualCollapsesAcrossRefreshWithoutChangingWorkspaceExpansion() {
        let projection = TaskFileTreeProjection(matches: [entry("src/deep/result.swift")], query: "result"), workspace: Set<String> = ["other"]
        var state = TaskFileTreeSearchState(); state.observe("result")
        XCTAssertEqual(projection.visible(expanded: state.expanded(projection, workspace: workspace)).count, 3)
        state.toggle(projection.roots[0], expanded: false); state.observe("result")
        XCTAssertEqual(projection.visible(expanded: state.expanded(projection, workspace: workspace)).map { $0.item.path }, ["src"])
        state.observe("different"); XCTAssertEqual(projection.visible(expanded: state.expanded(projection, workspace: workspace)).count, 3)
        let normal = TaskFileTreeProjection(entries: ["": [entry("other", "directory")]])
        XCTAssertEqual(state.expanded(normal, workspace: workspace), workspace)
    }
    func testOnlyExternalFileRevealsClearTheCurrentSearch() {
        var origin = TaskFileTreeSelectionOrigin()
        origin.openedFromTree("src/first.swift"); XCTAssertFalse(origin.revealClearsSearch("src/first.swift"))
        XCTAssertTrue(origin.revealClearsSearch("src/second.swift")); XCTAssertTrue(origin.revealClearsSearch("src/first.swift"))
        XCTAssertFalse(origin.revealClearsSearch(nil))
    }
    func testSingleDirectoryChainsCompactAndKeepTheActualDestinationAndExpansion() {
        let projection = TaskFileTreeProjection(entries: ["": [entry("src", "directory"), entry("empty", "directory")], "src": [entry("src/lib", "directory")], "src/lib": [entry("src/lib/file10.swift"), entry("src/lib/file2.swift")]])
        XCTAssertEqual(projection.roots.map(\.title), ["empty", "src/lib"])
        let source = projection.roots[1]; XCTAssertEqual(source.path, "src/lib"); XCTAssertEqual(source.chain, ["src", "src/lib"])
        XCTAssertEqual(projection.visible(expanded: ["src"]).map { $0.item.path }, ["empty", "src/lib", "src/lib/file2.swift", "src/lib/file10.swift"])
        XCTAssertEqual(projection.visible(expanded: []).count, 2)
    }
    func testDeepDirectoryChainsKeepTheirFinalFileInsteadOfStoppingAtAnArbitraryDepth() {
        var entries: [String: [TaskFileEntry]] = [:], parent = ""
        for _ in 0..<180 {
            let path = parent.isEmpty ? "d" : parent + "/d"; entries[parent] = [entry(path, "directory")]; parent = path
        }
        entries[parent] = [entry(parent + "/file.swift")]
        let projection = TaskFileTreeProjection(entries: entries)
        XCTAssertEqual(projection.roots[0].chain.count, 180); XCTAssertEqual(projection.roots[0].path, parent)
        XCTAssertEqual(projection.visible(expanded: ["d"]).map { $0.item.path }, [parent, parent + "/file.swift"])
    }
    func testBatchReferencesAppendAtTheEndWithABoundaryAndOneInsertionRequest() throws {
        let existing = reference("existing"), first = reference("first"), second = reference("second")
        let batch = try XCTUnwrap(TaskContextDocument.batch([first, second], text: "用户输入🚀", records: [existing], identity: "scope"))
        XCTAssertEqual(batch.records.map(\.id), ["existing", "first", "second"])
        XCTAssertEqual(TaskContextDocument.insertionRange(batch.insertion, text: "用户输入🚀", caret: NSRange(location: 0, length: 0)), NSRange(location: 6, length: 0))
        XCTAssertEqual(TaskContextDocument.insertionText(batch.insertion, text: "用户输入🚀"), " " + TaskContextDocument.token(first) + " " + TaskContextDocument.token(second) + " ")
        XCTAssertEqual(batch.insertion.additional, [second]); XCTAssertTrue(batch.insertion.focus)
    }
    func testBatchReusesCapturedReferencesAndEnforcesTheUniqueContextBudget() throws {
        let records = (0..<20).map { reference("ref\($0)") }, text = records.map(TaskContextDocument.token).joined(separator: " ")
        let duplicate = reference("different-id", path: "ref3", digest: "ref3")
        let reused = try XCTUnwrap(TaskContextDocument.batch([duplicate], text: text, records: records, identity: "scope"))
        XCTAssertEqual(reused.records.count, 20); XCTAssertEqual(reused.insertion.reference?.id, "ref3"); XCTAssertEqual(reused.insertion.previousOccurrences, 1)
        XCTAssertNil(TaskContextDocument.batch([reference("overflow")], text: text, records: records, identity: "scope"))
        XCTAssertNotNil(TaskContextDocument.batch([reference("free-slot")], text: "", records: records, identity: "scope"), "Unused cached references do not consume the message's budget")
    }
    func testOldDraftInsertionsDecodeAndKeepCaretInsertionWithoutNewBatchFields() throws {
        let insertion = TaskContextInsertion(reference: reference("file"), identity: "scope")
        let data = try JSONEncoder().encode(insertion), decoded = try JSONDecoder().decode(TaskContextInsertion.self, from: data)
        XCTAssertNil(decoded.additional); XCTAssertNil(decoded.atEnd)
        XCTAssertEqual(TaskContextDocument.insertionRange(decoded, text: "one two", caret: NSRange(location: 3, length: 0)), NSRange(location: 3, length: 0))
        XCTAssertEqual(TaskContextDocument.insertionText(decoded, text: "one two"), TaskContextDocument.token(try XCTUnwrap(insertion.reference)) + " ")
    }
}
