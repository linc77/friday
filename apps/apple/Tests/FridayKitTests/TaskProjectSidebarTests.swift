import Foundation
@main struct TaskProjectSidebarTests {
    struct Fixture: Decodable { let source: String; let bases: [Base]; let cases: [Case]; let threadSorts: [ThreadOrder] }
    struct Base: Decodable { let name: String; let projects: [Project]; let tasks: [WorkItem] }
    struct Case: Decodable { let base: Int; let mode: String; let sort: String; let overrides: [String: String]; let preferred: [String]; let expected: [Expected] }
    struct Expected: Codable, Equatable { let id: String; let name: String; let representative: String; let members: [String]; let projectIDs: [String] }
    struct ThreadOrder: Decodable { let order: String; let expected: [String] }
    static func main() throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        precondition(fixture.source == "8cd9641f76874f2ce17d6c80acd71fab1f0b99d3")
        for item in fixture.cases {
            let base = fixture.bases[item.base]
            let result = TaskProjectSidebar.groups(base.projects, tasks: base.tasks, mode: TaskProjectGrouping(rawValue: item.mode)!, overrides: item.overrides, order: TaskProjectSort(rawValue: item.sort)!, preferred: item.preferred)
                .map { Expected(id: $0.id, name: $0.name, representative: $0.representative.id, members: $0.members.map(\.id), projectIDs: $0.projectIDs.sorted()) }
            precondition(result == item.expected, "T3 grouping mismatch: \(base.name), \(item.mode), \(item.sort), \(item.overrides)\nActual \(result)\nExpected \(item.expected)")
        }
        let tasks = fixture.bases[0].tasks
        for order in fixture.threadSorts { precondition(TaskProjectSidebar.threads(tasks, order: TaskThreadSort(rawValue: order.order)!).map(\.id) == order.expected) }
        precondition(TaskProjectSidebar.preview(tasks, expanded: false, overflow: false, count: 2, selected: tasks.last?.id).map(\.id) == [tasks.last!.id])
        precondition(TaskProjectSidebar.preview(tasks, expanded: true, overflow: false, count: 2, selected: tasks.last?.id).count == 2)
        precondition(TaskProjectSidebar.preview(tasks, expanded: true, overflow: true, count: 2, selected: nil).count == tasks.count)
        let projects = TaskProjectSidebar.groups(fixture.bases[0].projects, tasks: tasks, mode: .repository)
        precondition(TaskProjectSidebar.search(projects, query: "  OWNER  ").allSatisfy { $0.name.lowercased().contains("owner") })
        let grouped = projects.first { $0.projectIDs.contains("main") }!
        precondition(Set(TaskProjectSidebar.filtered(tasks, group: grouped, projects: fixture.bases[0].projects).map(\.id)) == Set(["a","b","c","z"]))
        let scratchProjects = fixture.bases.first { $0.projects.contains { $0.isScratch == true } }!.projects
        func scratchTask(_ id: String, project: String?) throws -> WorkItem {
            var value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(tasks[0])) as! [String: Any]
            value["id"] = id; value["projectId"] = project.map { $0 as Any } ?? NSNull(); value["cwd"] = "/unassociated"
            return try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: value))
        }
        let scratchTasks = try [scratchTask("managed", project: "scratch-one"), scratchTask("legacy", project: nil), scratchTask("ordinary", project: "ordinary"), scratchTask("deleted", project: "removed")]
        let scratchGroups = TaskProjectSidebar.groups(scratchProjects, tasks: scratchTasks, mode: .repository)
        precondition(scratchGroups.filter { $0.scratch }.count == 1)
        let scratch = scratchGroups.first { $0.scratch }!
        precondition(scratch.draftProjectID != nil)
        precondition(Set(TaskProjectSidebar.filtered(scratchTasks, group: scratch, projects: scratchProjects).map(\.id)) == Set(["managed", "legacy"]))
        let version = TaskProjectSidebar.version(fixture.bases[0].projects, tasks: tasks, mode: .repository, overrides: [:], order: .updated, preferred: [], context: "host")
        var streaming = tasks
        var changed = try JSONSerialization.jsonObject(with: JSONEncoder().encode(tasks[0])) as! [String: Any]
        changed["result"] = "new streamed text"; changed["updatedAt"] = "2026-10-30T12:00:00Z"
        streaming[0] = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: changed))
        precondition(version == TaskProjectSidebar.version(fixture.bases[0].projects, tasks: streaming, mode: .repository, overrides: [:], order: .updated, preferred: [], context: "host"), "Assistant output must not invalidate project ordering with a known user timestamp")
        streaming[0].messages?.append(ChatMessage(id: "next-user", role: "user", text: "next", at: "2026-10-30T12:00:00Z"))
        precondition(version != TaskProjectSidebar.version(fixture.bases[0].projects, tasks: streaming, mode: .repository, overrides: [:], order: .updated, preferred: [], context: "host"))
        print("\(fixture.cases.count) independent T3 grouping/sorting cases, thread orders, collapsed selection, preview and scoped membership passed")
    }
}
