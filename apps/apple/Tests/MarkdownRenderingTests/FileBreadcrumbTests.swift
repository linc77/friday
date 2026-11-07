import XCTest
@testable import FridayKit

final class FileBreadcrumbTests: XCTestCase {
    func testCrumbsKeepTheWayBackDownAfterWalkingUpAndResetForASibling() {
        let trail = "src/lib/file.swift"
        XCTAssertEqual(TaskFileBreadcrumb.crumbs(project: "Friday", trail: trail).map(\.path), ["", "src", "src/lib", trail])
        XCTAssertEqual(TaskFileBreadcrumb.retained(trail, at: "src"), trail); XCTAssertEqual(TaskFileBreadcrumb.retained(trail, at: ""), trail)
        XCTAssertEqual(TaskFileBreadcrumb.retained(trail, at: "src-old"), "src-old")
        XCTAssertEqual(TaskFileBreadcrumb.path("src//lib/"), "src/lib"); XCTAssertEqual(TaskFileBreadcrumb.parent("src/lib"), "src"); XCTAssertEqual(TaskFileBreadcrumb.parent("src"), ""); XCTAssertNil(TaskFileBreadcrumb.parent(""))
    }
    func testOnlyImmediateChildrenAppearAndUseNaturalDirectoryFirstOrder() {
        let entries = [TaskFileEntry(path: "src/file10", name: "file10", kind: "file"), TaskFileEntry(path: "src/file2", name: "file2", kind: "file"), TaskFileEntry(path: "src/lib", name: "lib", kind: "directory"), TaskFileEntry(path: "src/lib/nested", name: "nested", kind: "file"), TaskFileEntry(path: "src-old/file", name: "file", kind: "file")]
        XCTAssertEqual(TaskFileBreadcrumb.children(entries, of: "src").map(\.path), ["src/lib", "src/file2", "src/file10"])
        let route = TaskFileNavigation.route("", taskID: "task", path: "src/100% #?+.txt"), query = URLComponents(string: route)?.queryItems
        XCTAssertTrue(route.hasPrefix("/api/task-files?")); XCTAssertEqual(query?.first { $0.name == "path" }?.value, "src/100% #?+.txt")
    }
    func testWalkingUpFromAFilePreservesItsTabAndFolderNavigationReplacesTheBrowser() {
        var state = TaskFilesPanelState(); state.open("src/lib/file.swift", line: 12)
        state.navigate("src/lib", trail: "src/lib/file.swift", keepSource: true)
        XCTAssertEqual(state.tabs.map(\.path), ["src/lib/file.swift", "src/lib"]); XCTAssertTrue(state.folderView); XCTAssertEqual(state.tabs[0].line, 12)
        state.navigate("src", trail: "src/lib/file.swift", keepSource: false)
        XCTAssertEqual(state.tabs.map(\.path), ["src/lib/file.swift", "src"]); XCTAssertEqual(state.tab?.trail, "src/lib/file.swift")
        state.navigate("src/lib/file.swift", trail: "src/lib/file.swift", keepSource: false)
        XCTAssertEqual(state.tabs.map(\.path), ["src/lib/file.swift"]); XCTAssertEqual(state.tab?.line, 12); XCTAssertFalse(state.folderView)
        XCTAssertTrue(state.expanded.contains("src/lib")); XCTAssertFalse(state.expanded.contains("src/lib/file.swift"))
    }
    func testExistingFolderTargetKeepsItsTrailAndRootIsASingletonInTheTabOrder() {
        var state = TaskFilesPanelState(); state.open("src/a.swift"); state.navigate("src", trail: "src/a.swift", keepSource: true)
        state.open("src/b.swift"); state.navigate("src", trail: "src/b.swift", keepSource: true)
        XCTAssertEqual(state.tabs.filter { $0.path == "src" }.count, 1); XCTAssertEqual(state.tab?.trail, "src/a.swift")
        state.navigate("", trail: "src/a.swift", keepSource: false); XCTAssertEqual(state.selected, ""); XCTAssertEqual(state.tab?.trail, "src/a.swift")
        state.open(""); XCTAssertEqual(state.tabs.filter { $0.path.isEmpty }.count, 1); XCTAssertEqual(state.tab?.trail, "src/a.swift")
        state.open("src/b.swift"); XCTAssertFalse(state.tabs.contains { $0.path.isEmpty })
    }
    func testDirectoryMetadataAndClosingTheLastSurfaceKeepVisibilityConsistent() throws {
        var state = TaskFilesPanelState(); state.open("src"); state.classify("src", directory: true)
        XCTAssertTrue(state.folderView); XCTAssertTrue(state.expanded.contains("src"))
        state.expanded.remove("src"); state.classify("src", directory: true); XCTAssertFalse(state.expanded.contains("src"), "Refreshing folder metadata must not reopen a folder the user collapsed")
        state.classify("src", directory: false); XCTAssertFalse(state.folderView)
        state.close("src"); XCTAssertFalse(state.visible); XCTAssertNil(state.selected)
        let legacy = #"{"tabs":[{"path":"file","reveal":0}],"selected":"file","expanded":[""],"explorerShown":false,"visible":true}"#
        let restored = try JSONDecoder().decode(TaskFilesPanelState.self, from: Data(legacy.utf8)); XCTAssertFalse(restored.folderView); XCTAssertNil(restored.tab?.trail)
        state.open("file"); state.navigate("", trail: "file", keepSource: true)
        XCTAssertEqual(try JSONDecoder().decode(TaskFilesPanelState.self, from: JSONEncoder().encode(state)), state)
    }
    func testTheRetainedFileCanBeReopenedAfterItsOriginalTabWasClosed() {
        var state = TaskFilesPanelState(); state.open("src/file.swift"); state.navigate("src", trail: "src/file.swift", keepSource: true)
        state.close("src/file.swift"); state.navigate("src/file.swift", trail: "src/file.swift", keepSource: false)
        XCTAssertEqual(state.selected, "src/file.swift"); XCTAssertFalse(state.folderView)
        XCTAssertTrue(state.expanded.contains("src")); XCTAssertFalse(state.expanded.contains("src/file.swift"))
        state.classify("src/file.swift", directory: false); XCTAssertFalse(state.expanded.contains("src/file.swift"))
    }
}
