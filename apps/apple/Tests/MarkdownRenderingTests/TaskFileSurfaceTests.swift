import XCTest
@testable import FridayKit

final class TaskFileSurfaceTests: XCTestCase {
    func testParsedTaskMarkersAddressOnlyTheCorrectUTF16SourceCharacter() throws {
        for prefix in ["", "\u{feff}"] {
        let source = prefix + "🚀 中文\r\n\r\n- [ ] first\r\n  - [X] nested\r\n\r\n```md\n- [ ] code\n```\n\n<ul><li data-friday-task-marker='0'><input type='checkbox'>HTML</li></ul>"
        let blocks = try XCTUnwrap(NativeMarkdownParser.shared.parse(source))
        guard case .list(let list) = blocks[1], case .list(let nested) = list.items[0].blocks[1], case .list(let html) = blocks.last else { return XCTFail("List structure or task parser missing") }
        let text = source as NSString, first = text.range(of: "[ ] first").location, second = text.range(of: "[X] nested").location
        XCTAssertEqual(list.items[0].markerOffset, first); XCTAssertEqual(nested.items[0].markerOffset, second); XCTAssertNil(html.items[0].markerOffset)
        XCTAssertEqual(TaskFileNavigation.settingTaskChecked(in: source, markerOffset: first, checked: true), text.replacingCharacters(in: NSRange(location: first + 1, length: 1), with: "x"))
        XCTAssertEqual(TaskFileNavigation.settingTaskChecked(in: source, markerOffset: second, checked: false), text.replacingCharacters(in: NSRange(location: second + 1, length: 1), with: " "))
        XCTAssertNil(TaskFileNavigation.settingTaskChecked(in: source, markerOffset: -1, checked: true)); XCTAssertNil(TaskFileNavigation.settingTaskChecked(in: source, markerOffset: text.length, checked: true))
        XCTAssertNil(TaskFileNavigation.settingTaskChecked(in: source, markerOffset: 0, checked: true))
        }
    }
    func testFileTabsKeepTheirPositionsAndRepeatedLineRequestsDoNotDuplicateTabs() throws {
        var state = TaskFilesPanelState(); state.open("src/one.swift", line: 8); state.open("src/two.swift")
        XCTAssertTrue(state.visible); XCTAssertEqual(state.tabs.map(\.path), ["src/one.swift", "src/two.swift"]); XCTAssertTrue(state.expanded.contains("src"))
        state.open("src/one.swift", line: 12); XCTAssertEqual(state.tabs.count, 2); XCTAssertEqual(state.tab?.line, 12); XCTAssertEqual(state.tab?.reveal, 1)
        state.close("src/one.swift"); XCTAssertEqual(state.selected, "src/two.swift"); state.open(""); XCTAssertEqual(state.selected, ""); XCTAssertEqual(state.tabs.count, 2); XCTAssertTrue(state.folderView)
        let preferences = TaskPanelPreferences(diff: TaskDiffSelection(path: "a"), width: 620, files: state, activePanel: "files")
        let restored = try JSONDecoder().decode(TaskPanelPreferences.self, from: JSONEncoder().encode(preferences))
        XCTAssertEqual(restored.files, state); XCTAssertEqual(restored.activePanel, "files")
        let legacy = try JSONDecoder().decode(TaskPanelPreferences.self, from: Data(#"{"width":460,"terminalShown":true}"#.utf8)); XCTAssertNil(legacy.files); XCTAssertNil(legacy.activePanel)
    }
    func testWorkspaceLinksResolveFromTheirDocumentDirectoryAndKeepLineTargets() {
        XCTAssertEqual(TaskFileNavigation.location("../Sources/A.swift:12:3", basePath: "/host/project/docs", workspaceRoot: "/host/project"), TaskFileLocation(path: "Sources/A.swift", line: 12))
        XCTAssertEqual(TaskFileNavigation.location("file:///host/project/a%20b.swift#L32", basePath: nil, workspaceRoot: "/host/project"), TaskFileLocation(path: "a b.swift", line: 32))
        XCTAssertEqual(TaskFileNavigation.location("./", basePath: "/host/project", workspaceRoot: "/host/project"), TaskFileLocation(path: ""))
        XCTAssertNil(TaskFileNavigation.location("../other/file.swift", basePath: "/host/project", workspaceRoot: "/host/project"))
        XCTAssertNil(TaskFileNavigation.location("https://example.com/a.swift", basePath: "/host/project", workspaceRoot: "/host/project"))
    }
    func testFileFramesUseHTTPInsideTheSameOpaqueSandboxAsT3() throws {
        let url = try XCTUnwrap(URL(string: "https://host.test/file-assets/capability/docs/index%22&.html"))
        let html = try XCTUnwrap(WorkspaceDocumentPolicy.wrapper(url: url, pdf: false))
        XCTAssertTrue(html.contains(#"sandbox="allow-scripts allow-forms allow-popups allow-downloads""#)); XCTAssertFalse(html.contains("allow-same-origin")); XCTAssertTrue(html.contains("&amp;"))
        XCTAssertTrue(html.contains(#"referrerpolicy="no-referrer""#)); XCTAssertFalse(html.contains("Authorization"))
        let pdf = try XCTUnwrap(WorkspaceDocumentPolicy.wrapper(url: URL(string: "https://host.test/file-assets/cap/report.pdf")!, pdf: true))
        XCTAssertFalse(pdf.contains(" sandbox=")); XCTAssertTrue(pdf.contains("toolbar=0&amp;view=FitH"))
        for raw in ["file:///private/file", "javascript:bad()", "https://user:secret@host.test/file"] { XCTAssertNil(WorkspaceDocumentPolicy.wrapper(url: URL(string: raw)!, pdf: false)) }
    }
    func testSourceLineRangesFollowUTF16AndCRLFWithoutChangingSource() {
        let source = "🚀 café\r\n第二行\nlast", lines = TaskSourceLines(source), text = source as NSString
        XCTAssertEqual(lines.starts.count, 3); XCTAssertEqual(text.substring(with: lines.range(line: 2)), "第二行\n")
        XCTAssertEqual(lines.number(at: lines.starts[1]), 2); XCTAssertEqual(text.substring(with: lines.range(line: 999)), "last")
        XCTAssertEqual(TaskSourceLines("one\n").starts, [0, 4]); XCTAssertEqual(TaskSourceLines("").range(line: 1), NSRange(location: 0, length: 0))
    }
    func testLoadedDirectoryProjectionKeepsEmptyFoldersAndCollapsedDescendantsOutOfTheVisibleTree() {
        let entries: [String: [TaskFileEntry]] = ["": [TaskFileEntry(path: "src", name: "src", kind: "directory"), TaskFileEntry(path: "empty", name: "empty", kind: "directory")], "src": [TaskFileEntry(path: "src/a.swift", name: "a.swift", kind: "file")]]
        let projection = TaskFileTreeProjection(entries: entries)
        XCTAssertEqual(projection.visible(expanded: [""]).map { $0.item.path }, ["empty", "src"])
        let expanded = projection.visible(expanded: ["", "src"]); XCTAssertEqual(expanded.map { $0.item.path }, ["empty", "src", "src/a.swift"]); XCTAssertEqual(expanded.map(\.depth), [0, 0, 1])
    }
    @MainActor func testAssetFrameRequestsNeverCarryTheApplicationCredential() throws {
        let name = "Friday.FileAssets.Test." + UUID().uuidString, defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("https://fixture.invalid", forKey: "friday.server")
        let connection = Connection(defaults: defaults, environment: [:], development: false)
        connection.token = "fixture-owner-credential"
        let api = try connection.request("/api/task-files/asset-url"); XCTAssertEqual(api.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-owner-credential")
        let asset = try connection.request("/file-assets/scoped-capability/docs/index.html")
        XCTAssertNil(asset.value(forHTTPHeaderField: "Authorization")); XCTAssertEqual(asset.url?.host, "fixture.invalid")
    }

}
