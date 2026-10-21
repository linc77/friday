import XCTest
@testable import FridayKit

final class HostFilesTests: XCTestCase {
    func testHostNavigationKeepsOutsidePathsAbsoluteAndConvertsWorkspaceDescendantsBackToPanelPaths() throws {
        let root = "/repo/project"
        XCTAssertEqual(TaskHostPath.panel("/repo/project", root: root), "")
        XCTAssertEqual(TaskHostPath.panel("/repo/project/src/a.swift", root: root), "src/a.swift")
        XCTAssertEqual(TaskHostPath.panel("/repo/project-other/a.swift", root: root), "/repo/project-other/a.swift")
        XCTAssertEqual(TaskHostPath.absolute("/host/a #?%20.swift", root: root), "/host/a #?%20.swift")
        XCTAssertEqual(TaskHostPath.relative("/host/a", root: "/"), "host/a")
        let url = URL(fileURLWithPath: "/host/a #?%20.swift").absoluteString + "#L12"
        XCTAssertNil(TaskFileNavigation.location(url, basePath: nil, workspaceRoot: root))
        XCTAssertEqual(TaskFileNavigation.location(url, basePath: nil, workspaceRoot: root, allowHost: true), TaskFileLocation(path: "/host/a #?%20.swift", line: 12))
        let context = TaskFileOpenContext(root: root, open: { _ in })
        XCTAssertEqual(try XCTUnwrap(context.target(url, basePath: nil)).path, "/host/a #?%20.swift")
    }
    func testHostBreadcrumbsHaveNoWorkspaceLabelAndKeepTheirAbsoluteTrail() {
        let crumbs = TaskFileBreadcrumb.crumbs(project: "Project", trail: "/Users/name/file.md")
        XCTAssertEqual(crumbs.map(\.label), ["Users", "name", "file.md"])
        XCTAssertEqual(crumbs.map(\.path), ["/Users", "/Users/name", "/Users/name/file.md"])
        XCTAssertEqual(TaskFileBreadcrumb.parent("/Users"), "/")
        XCTAssertNil(TaskFileBreadcrumb.parent("/"))
        XCTAssertEqual(TaskFileBreadcrumb.path("//Users//name/"), "/Users/name")
        XCTAssertEqual(TaskFileBreadcrumb.retained("/Users/name/file.md", at: "/Users"), "/Users/name/file.md")
        XCTAssertEqual(TaskFileBreadcrumb.retained("/repo/project/a.md", at: ""), "")
        XCTAssertEqual(TaskFileBreadcrumb.children([TaskFileEntry(path: "/Users", name: "Users", kind: "directory"), TaskFileEntry(path: "/Users/name", name: "name", kind: "directory")], of: "/").map(\.path), ["/Users"])
    }
    func testHostFolderTabsKeepSourceFilesAndNeverPolluteWorkspaceExpansionState() {
        var state = TaskFilesPanelState()
        state.open("src/a.swift"); let expanded = state.expanded
        state.open("/host/file.md")
        state.navigate("/host", trail: "/host/file.md", keepSource: true)
        XCTAssertEqual(state.tabs.map(\.path), ["src/a.swift", "/host/file.md", "/host"])
        XCTAssertTrue(state.folderView); XCTAssertEqual(state.tab?.trail, "/host/file.md")
        state.classify("/host", directory: true)
        XCTAssertEqual(state.expanded, expanded)
        state.open("/host/file.md"); XCTAssertFalse(state.folderView)
        state.navigate("/host", trail: "/host/file.md", keepSource: true)
        XCTAssertEqual(state.tabs.count, 3)
    }
    func testHostMentionsContainAbsoluteURIsAndRemainBoundToTheOriginalServiceWorkspace() throws {
        let entry = TaskFileEntry(path: "sub/a #?%20.swift", name: "a #?%20.swift", kind: "file")
        let mention = TaskFileMention(TaskHostPath.entry(entry, root: "/host"))
        XCTAssertTrue(mention.valid); XCTAssertEqual(mention.path, "/host/sub/a #?%20.swift")
        XCTAssertTrue(mention.markdown.contains("/host/sub/a%20%23%3F%2520.swift"))
        let scope = String(repeating: "a", count: 64), payload = TaskFileMentionPayload(scope: scope, entries: [mention])
        XCTAssertEqual(TaskFileMentionPayload.decode(try XCTUnwrap(payload.data)), payload)
        XCTAssertNil(TaskFileMentionPayload.combine([payload, TaskFileMentionPayload(scope: String(repeating: "b", count: 64), entries: [mention])]))
        XCTAssertTrue(TaskFileMention(path: "/", kind: "directory").valid)
        XCTAssertFalse(TaskFileMention(path: "/", kind: "file").valid)
        XCTAssertFalse(TaskFileMention(path: "/host/.git/config", kind: "file").valid)
    }
    func testHostSearchOnlyFiltersTheProvidedLoadedEntriesAndKeepsTreePathsRelative() {
        let entries = [TaskFileEntry(path: "loaded/Alpha.swift", name: "Alpha.swift", kind: "file"), TaskFileEntry(path: "loaded/beta.txt", name: "beta.txt", kind: "file")]
        XCTAssertTrue(TaskHostPath.loadedMatches(entries, query: "alpsw").isEmpty)
        XCTAssertEqual(TaskHostPath.loadedMatches(entries, query: " Alpha.SW ").map(\.path), ["loaded/Alpha.swift"])
        XCTAssertTrue(TaskHostPath.loadedMatches(entries, query: "not-loaded").isEmpty)
        let selected = TaskHostPath.loadedMatches(entries, query: "Alpha")
        let projection = TaskFileTreeProjection(entries: ["loaded": entries], matches: selected, query: "Alpha")
        XCTAssertTrue(projection.directories.contains("loaded")); XCTAssertFalse(projection.roots.isEmpty)
    }
    func testSearchMatchesThePublishedPierreVersionIncludingUnicodeAndImplicitDirectories() throws {
        struct Golden: Decodable { let paths: [String]; let query: String; let matches: [String] }
        struct Fixtures: Decodable { let source: String; let cases: [Golden] }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/pierre-tree-search.json")
        let fixtures = try JSONDecoder().decode(Fixtures.self, from: Data(contentsOf: url))
        XCTAssertTrue(fixtures.source.contains("1.0.0-beta.6")); XCTAssertEqual(fixtures.cases.count, 26)
        for fixture in fixtures.cases {
            let entries = fixture.paths.map { path in let directory = path.hasSuffix("/"); let path = directory ? String(path.dropLast()) : path; return TaskFileEntry(path: path, name: path.split(separator: "/").last.map(String.init) ?? path, kind: directory ? "directory" : "file") }
            let actual = TaskFileTreeSearch.matching(entries, query: fixture.query).map { $0.path + ($0.kind == "directory" ? "/" : "") }
            XCTAssertEqual(Set(actual), Set(fixture.matches), fixture.query.debugDescription)
        }
    }
    func testLoadedIgnoredFilesRemainSearchableWhenServerSearchIsEmptyAndKeepTheirMetadata() throws {
        let ignored = TaskFileEntry(path: "ignored/.env.local", name: ".env.local", kind: "file", ignored: true)
        let projection = TaskFileTreeProjection(entries: ["ignored": [ignored]], matches: [], query: "env.local")
        let rows = projection.visible(expanded: projection.directories)
        XCTAssertEqual(try XCTUnwrap(rows.first { $0.item.path == ignored.path }).item.entry.ignored, true)
        let matches = TaskFileTreeSearch.matching([ignored, TaskFileEntry(path: ignored.path, name: ignored.name, kind: "file")], query: "env.local")
        XCTAssertEqual(matches.first?.ignored, true)
        XCTAssertFalse(TaskFileTreeProjection(entries: ["ignored": [ignored]], query: "\u{FEFF} ").searching)
    }
}
