import Foundation

@main struct TaskSidebarStateTests {
    static func task(_ id: String, _ overrides: [String: Any] = [:]) throws -> WorkItem {
        var data: [String: Any] = ["id": id, "title": "Task \(id)", "agent": "codex", "prompt": "", "cwd": "/project", "mode": "code",
            "createdAt": "2026-10-18T01:00:00Z", "updatedAt": "2026-10-18T02:00:00Z", "status": "completed", "events": [], "approvals": [], "result": ""]
        data.merge(overrides) { _, new in new }
        return try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: data))
    }
    @MainActor static func main() async throws {
        try workingShelves()
        try multiSelection()
        try await bulkRequests()
        let nativeOrigin: [String: Any] = ["rootTaskId": "parent", "parentTaskId": "parent", "subagentId": "native", "sessionId": "process", "threadId": "provider", "nativeId": "agent", "status": "unknown"]
        let nativeChild = try task("native-child", ["agent": "claude", "status": "interrupted", "subagentOrigin": nativeOrigin])
        let rootTask = try task("parent")
        precondition(TaskWorkspaces.tasks([rootTask, nativeChild], scope: nil, projects: []).map(\.id) == [rootTask.id], "Native child conversations open through their parent and never become top-level sidebar tasks")
        precondition(nativeChild.statusText == "状态未确认", "A disconnected provider child cannot claim a resumable human run")
        let interruptedChild = try task("native-child", ["agent": "claude", "status": "interrupted", "subagentOrigin": nativeOrigin.merging(["status": "interrupted"]) { _, new in new }])
        precondition(interruptedChild.statusText == "已中断")
        var rename = TaskTitleRenameState()
        rename.begin(taskID: "task", title: "Original", scope: "account:one")
        let token = rename.edit!.id
        rename.change("  改进输出 🌏  ", token: token)
        precondition(rename.finish(token: token, scope: "account:one", currentTitle: "Original") == .save(taskID: "task", title: "改进输出 🌏"))
        precondition(rename.finish(token: token, scope: "account:one", currentTitle: "Original") == nil, "Blur after Return cannot submit the rename a second time")
        rename.begin(taskID: "task", title: "Original", scope: "account:one")
        let cancelled = rename.edit!.id; rename.change("Discard", token: cancelled)
        precondition(rename.finish(token: cancelled, scope: "account:one", currentTitle: "Original", cancelled: true) == .cancelled)
        precondition(rename.finish(token: cancelled, scope: "account:one", currentTitle: "Original") == nil, "Blur after Escape cannot save cancelled text")
        rename.begin(taskID: "new-task", title: "New task", scope: "account:one")
        let newer = rename.edit!.id
        rename.change("Old callback", token: token)
        precondition(rename.finish(token: token, scope: "account:one", currentTitle: "Original") == nil)
        precondition(rename.edit?.id == newer && rename.edit?.text == "New task", "A dismantled native field cannot overwrite another editing session")
        precondition(rename.finish(token: newer, scope: "account:two", currentTitle: "New task") == .cancelled, "Account changes retire the old field without sending its title")
        for value in [" \n ", "line\nbreak", "\tTitle", String(repeating: "a", count: 201), String(repeating: "😀", count: 101)] {
            rename.begin(taskID: "task", title: "Original", scope: "account")
            let token = rename.edit!.id; rename.change(value, token: token)
            guard case .invalid? = rename.finish(token: token, scope: "account", currentTitle: "Original") else { preconditionFailure("Invalid native title reached the service: \(value)") }
        }
        rename.begin(taskID: "task", title: "Original", scope: "account")
        let emoji = rename.edit!.id; rename.change(String(repeating: "😀", count: 100), token: emoji)
        guard case .save? = rename.finish(token: emoji, scope: "account", currentTitle: "Original") else { preconditionFailure("The service accepts 200 UTF-16 units") }
        rename.begin(taskID: "task", title: "Current", scope: "account")
        precondition(rename.finish(token: rename.edit!.id, scope: "account", currentTitle: "Current") == .unchanged)
        rename.begin(taskID: "task", title: "Earlier", scope: "account")
        let concurrent = rename.edit!.id; rename.change("Remote title", token: concurrent)
        precondition(rename.finish(token: concurrent, scope: "account", currentTitle: "Remote title") == .unchanged, "A matching remote rename needs no duplicate write")
        rename.begin(taskID: "task", title: "Original", scope: "account"); rename.cancel(); precondition(rename.edit == nil)

        let now = CodexTranscript.date("2026-10-18T03:00:00Z")!
        let managed = try task("managed", ["settlementManaged": true, "updatedAt": "2026-10-01T02:00:00Z"])
        let legacyExpired = try task("legacy-expired", ["updatedAt": "2026-10-01T02:00:00Z"])
        precondition(TaskWorkspaces.shelf(managed, now: now) == .active && TaskWorkspaces.shelf(legacyExpired, now: now) == .settled, "New hosts own persistence; only old hosts use the three-day compatibility fallback")
        let active = try task("active")
        let pin = try task("pin", ["pinnedAt": "2026-10-18T02:00:00Z"])
        let settled = try task("settled", ["settledAt": "2026-10-18T02:00:00Z"])
        let asleep = try task("snoozed", ["snoozedUntil": "2026-10-19T02:00:00Z"])
        let archived = try task("archived", ["archivedAt": "2026-10-18T02:00:00Z"])
        let input = [settled, active, archived, asleep, pin]
        precondition(TaskSidebarNavigation.visible(input, now: now, expanded: [], selected: nil).map(\.id) == ["pin", "active"])
        precondition(TaskSidebarNavigation.visible(input, now: now, expanded: [], selected: "settled").map(\.id) == ["pin", "active", "settled"], "A selected collapsed-shelf row remains in the keyboard order")
        let ids = TaskSidebarNavigation.visible(input, now: now, expanded: ["settled", "snoozed"], selected: nil).map(\.id)
        precondition(ids == ["pin", "active", "snoozed", "settled"])
        precondition(TaskSidebarNavigation.adjacent(ids, selected: nil, direction: .next) == "pin")
        precondition(TaskSidebarNavigation.adjacent(ids, selected: nil, direction: .previous) == "settled")
        precondition(TaskSidebarNavigation.adjacent(ids, selected: "pin", direction: .previous) == nil)
        precondition(TaskSidebarNavigation.adjacent(ids, selected: "settled", direction: .next) == nil)
        precondition(TaskSidebarNavigation.adjacent(ids, selected: "active", direction: .next) == "snoozed")
        precondition(TaskSidebarNavigation.adjacent(ids, selected: "archived", direction: .next) == nil, "A hidden current thread cannot wrap into another section")
        precondition(TaskSidebarNavigation.adjacent([], selected: nil, direction: .next) == nil)
        precondition(TaskSidebarNavigation.jump(0, ids: ids) == "pin" && TaskSidebarNavigation.jump(4, ids: ids) == nil)
        precondition(TaskSidebarNavigation.jump(-1, ids: ids) == nil && TaskSidebarNavigation.jump(9, ids: Array(repeating: "task", count: 12)) == nil)
        let pinA = try task("a", ["pinnedAt": "2026-10-18T02:00:00Z", "pinOrderKey": "g", "createdAt": "2026-10-17T01:00:00Z"])
        let pinB = try task("b", ["pinnedAt": "2026-10-18T01:00:00Z", "pinOrderKey": "t"])
        let keyless = try task("keyless", ["pinnedAt": "2026-10-18T02:59:00Z", "createdAt": "2026-10-18T02:00:00Z"])
        precondition(TaskWorkspaces.shelfTasks([pinB, keyless, pinA], shelf: .pinned, now: now).map(\.id) == ["a", "b", "keyless"], "Pinned keys precede keyless creation order, independently of pin or output time")
        let created = try task("created", ["createdAt": "2026-10-18T02:00:00Z", "updatedAt": "2026-10-18T02:00:00Z"])
        let resumed = try task("resumed", ["createdAt": "2026-10-17T01:00:00Z", "unsettledAt": "2026-10-18T02:30:00Z"])
        let keyed = try task("keyed", ["activeOrderKey": "g", "updatedAt": "2099-10-18T02:59:00Z"])
        precondition(TaskWorkspaces.shelfTasks([keyed, created, resumed], shelf: .active, now: now).map(\.id) == ["resumed", "created", "keyed"], "New and resumed keyless tasks precede the manually ordered run; live output never jumps the row")
        let dragToken = UUID(); let payload = TaskSidebarDragPayload(token: dragToken, taskID: "b", section: "pinned")
        let move = TaskSidebarOrdering.plan(payload, token: dragToken, tasks: [pinA, pinB], projectID: "workspace", section: .pinned, over: "a", after: false, now: now)!
        precondition(move.body["orderedIds"] as? [String] == ["b", "a"] && move.body["projectId"] as? String == "workspace")
        precondition((move.body["expected"] as? [[String: Any]])?.map { $0["id"] as? String } == ["a", "b"])
        precondition(move.body["token"] == nil, "Window drag tokens never cross the service boundary")
        precondition(TaskSidebarOrdering.plan(payload, token: UUID(), tasks: [pinA, pinB], projectID: nil, section: .pinned, over: "a", after: false, now: now) == nil, "A previous account, scope, or service incarnation cannot drop into the new one")
        precondition(TaskSidebarOrdering.plan(payload, token: dragToken, tasks: [pinA, pinB], projectID: nil, section: .pinned, over: "a", after: true, now: now) == nil, "Dropping in the current slot is a no-op")
        precondition(TaskSidebarOrdering.plan(payload, token: dragToken, tasks: [pinA, pinB], projectID: nil, section: .snoozed, over: nil, after: false, now: now) == nil)
        precondition(TaskSidebarOrdering.plan(payload, token: dragToken, tasks: [pinA], projectID: nil, section: .active, over: nil, after: false, now: now) == nil, "A removed source cannot move")
        let moved = TaskSidebarOrdering.plan(payload, token: dragToken, tasks: [pinA, pinB, active], projectID: nil, section: .active, over: "active", after: true, now: now)!
        precondition(moved.body["orderedIds"] as? [String] == ["active", "b"])
        let decodedPayload = try JSONDecoder().decode(TaskSidebarDragPayload.self, from: JSONEncoder().encode(payload))
        precondition(decodedPayload == payload)
        var opened: [String] = []; var modelChoices: [Int] = []
        let navigation = TaskNavigationActions(rows: [pin, active, asleep, settled], selected: "active", model: nil, editingTitle: false, open: { opened.append($0) })
        navigation.jump(0); navigation.jump(3); navigation.jump(8); navigation.jump(9)
        precondition(opened == ["pin", "settled"] && navigation.previous == "pin" && navigation.next == "snoozed")
        let models = TaskModelJumpContext(owner: UUID(), revision: UUID(), titles: ["Unavailable", "Available"], enabled: [1], choose: { modelChoices.append($0) })
        let picker = TaskNavigationActions(rows: [pin, active], selected: "active", model: models, editingTitle: false, open: { opened.append($0) })
        precondition(picker.title(0) == "Unavailable" && !picker.enabled(0) && picker.enabled(1))
        picker.jump(0); picker.jump(1); picker.jump(2)
        precondition(modelChoices == [1] && opened == ["pin", "settled"], "Model shortcuts preserve disabled providers and cannot fall through to underlying tasks")
        let editor = TaskNavigationActions(rows: [pin, active], selected: "active", model: models, editingTitle: true, open: { opened.append($0) })
        editor.jump(1)
        precondition(!editor.enabled(1) && editor.previous == nil && editor.next == nil && modelChoices == [1], "Title editing owns keyboard input instead of triggering navigation")

        let origin: [String: Any] = ["taskId": "root", "runId": "run", "title": "Old root title", "rootTaskId": "root"]
        let parent = try task("root", ["title": "Current root", "archivedAt": "2026-10-18T02:00:00Z"])
        let child = try task("child", ["forkOrigin": origin])
        let old = try task("old", ["forkOrigin": origin, "createdAt": "2026-10-17T01:00:00Z", "updatedAt": "2026-10-20T01:00:00Z"])
        let newest = try task("new", ["forkOrigin": origin, "createdAt": "2026-10-19T01:00:00Z"])
        let rows = TaskRelationships.rows(for: parent, in: [child, old, parent, newest])
        precondition(rows.map(\.taskID) == ["new", "child", "old"], "Sibling forks follow creation time, independently of later activity")
        let childRows = TaskRelationships.rows(for: child, in: [child, old, parent, newest])
        precondition(childRows.count == 1 && childRows[0].parent && childRows[0].title == "Current root" && childRows[0].task?.archivedAt != nil)
        let missing = TaskRelationships.rows(for: child, in: [child, old, newest])
        precondition(missing.count == 1 && missing[0].task == nil && missing[0].title == "Old root title", "A removed parent retains provenance without becoming a working navigation link")
        let descendant = try task("grandchild", ["forkOrigin": ["taskId": "child", "runId": "run", "title": "Child", "rootTaskId": "root"]])
        precondition(!TaskRelationships.rows(for: parent, in: [parent, child, descendant]).contains { $0.taskID == "grandchild" }, "The panel shows immediate relationships rather than inventing a nested sidebar")
        let cycle = try task("root", ["forkOrigin": ["taskId": "child", "runId": "run", "title": "Child", "rootTaskId": "root"]])
        let cycleRows = TaskRelationships.rows(for: cycle, in: [cycle, child, child])
        precondition(cycleRows.count == 1 && cycleRows[0].parent)
        let selfReference = try task("root", ["forkOrigin": origin])
        precondition(TaskRelationships.rows(for: selfReference, in: [selfReference]).isEmpty)
        let unrelated = try task("delegated", ["parentId": "root"])
        precondition(TaskRelationships.rows(for: parent, in: [unrelated, parent]).isEmpty, "A legacy delegation parent ID is not a confirmed native subagent or fork edge")
        let delegationParent = try task("parent")
        let delegated = try task("delegated", ["delegationOrigin": ["id": "receipt", "parentTaskId": "parent", "parentRunId": "run", "role": "review", "isolation": "shared"]])
        let delegatedRows = TaskRelationships.rows(for: delegationParent, in: [delegationParent, delegated])
        precondition(delegatedRows.count == 1 && delegatedRows[0].delegated && !delegatedRows[0].parent)
        let delegatedParent = TaskRelationships.rows(for: delegated, in: [delegationParent, delegated])
        precondition(delegatedParent.count == 1 && delegatedParent[0].parent && delegatedParent[0].taskID == "parent")
        precondition(TaskBulkSelection(tasks: [delegationParent, delegated], selected: ["parent", "delegated"]).count == 1, "Backing child tasks cannot enter top-level bulk mutations")
        precondition(TaskWorkspaces.tasks([delegationParent, delegated], scope: nil, projects: []).map(\.id) == ["parent"], "The sidebar lists the parent while the relationship control exposes its child")
        let friday = try task("friday", ["agent": "friday", "forkOrigin": origin])
        precondition(TaskRelationships.rows(for: friday, in: [parent, friday]).isEmpty)
        precondition(TaskRelationships.visible(6, total: 20) == 6 && TaskRelationships.showMore(6, total: 20) == 18 && TaskRelationships.showMore(18, total: 20) == 20)
        print("Task title commit/cancel, UTF-16 bounds, duplicate/obsolete callbacks and connection isolation passed")
        print("Visible shelf keyboard order, first-nine jumps, traversal boundaries and collapsed selection passed")
        print("Model shortcut precedence, unavailable choices and title-edit keyboard ownership passed")
        print("Immediate fork relationships, archived/missing parents, stable creation order, cycle guards and 6/12 paging passed")
    }

    static func workingShelves() throws {
        func at(_ hour: Int) -> String { String(format: "2026-10-18T%02d:00:00Z", hour) }
        func activity(_ working: Bool, sent: String? = nil, requested: String? = nil, completed: String? = nil) -> [String: Any] {
            ["working": working, "latestUserAuthoredMessageAt": sent as Any? ?? NSNull(), "latestRunRequestedAt": requested as Any? ?? NSNull(), "latestRunCompletedAt": completed as Any? ?? NSNull()]
        }
        let now = CodexTranscript.date(at(12))!
        let running = try task("running", ["status": "running", "sidebarActivity": activity(true, sent: at(3), requested: at(10))])
        let lastSent = try task("last-sent", ["status": "running", "sidebarActivity": activity(true, sent: at(5))])
        let automatic = try task("automatic", ["status": "running", "sidebarActivity": activity(true, requested: at(11))])
        let approval = try task("approval", ["status": "waiting", "sidebarActivity": activity(false, sent: at(4), requested: at(4))])
        let finished = try task("finished", ["sidebarActivity": activity(false, sent: at(2), requested: at(2), completed: at(11)), "activeOrderKey": "z"])
        let earlier = try task("earlier", ["sidebarActivity": activity(false, requested: at(1), completed: at(6)), "activeOrderKey": "b"])
        precondition(TaskWorkspaces.shelf(running, now: now) == .active)
        precondition(TaskWorkspaces.shelf(running, now: now, workingShelfEnabled: true) == .working)
        precondition(TaskWorkspaces.shelf(approval, now: now, workingShelfEnabled: true) == .active, "Compact summaries keep a pending question in the inbox without carrying its private input")
        precondition(TaskWorkspaces.shelfTasks([automatic, running, lastSent], shelf: .working, now: now, workingShelfEnabled: true).map(\.id) == ["last-sent", "running", "automatic"], "A later automatic run cannot displace a later human send; explicit no-human metadata never falls back to run time")
        precondition(TaskWorkspaces.shelfTasks([approval, finished, earlier], shelf: .active, now: now, workingShelfEnabled: true).map(\.id) == ["finished", "earlier", "approval"])
        let observed = CodexTranscript.date(at(12))!
        precondition(TaskWorkspaces.shelfTasks([approval, finished], shelf: .active, now: now, workingShelfEnabled: true, returnedAt: ["approval": observed]).map(\.id) == ["approval", "finished"])
        precondition(TaskWorkspaces.shelfTasks([finished, earlier], shelf: .active, now: now).map(\.id) == ["earlier", "finished"], "Turning the beta off restores saved manual keys")
        var tracker = TaskInboxReturnTracker()
        tracker.observe([running, approval], context: "account:service", now: now)
        precondition(tracker.returnedAt.isEmpty, "The first observation never invents a completion or request")
        let returned = try task("running", ["status": "waiting", "sidebarActivity": activity(false, sent: at(3), requested: at(10))])
        tracker.observe([returned, approval], context: "account:service", now: now)
        precondition(tracker.returnedAt["running"] == now && tracker.returnedAt["approval"] == nil)
        tracker.observe([returned, approval], context: "account:service", now: now.addingTimeInterval(60))
        precondition(tracker.returnedAt["running"] == now, "An unrelated token or view refresh does not re-stamp a return")
        tracker.observe([approval], context: "account:service", now: now)
        precondition(tracker.returnedAt.isEmpty, "Deleted tasks are removed from the observed-return map")
        tracker.observe([running], context: "account:service", now: now)
        tracker.observe([returned], context: "account:service", now: now)
        tracker.observe(nil, context: "account:service", now: now)
        precondition(tracker.returnedAt.isEmpty, "Disabling the beta clears the tracker")
        tracker.observe([running], context: "account:service", now: now)
        tracker.observe([returned], context: "account:new-service", now: now)
        precondition(tracker.returnedAt.isEmpty, "A new service cannot fabricate a transition from the previous incarnation")
        let rows = [running, finished, approval]
        precondition(TaskSidebarNavigation.visible(rows, now: now, expanded: [], selected: nil, workingShelfEnabled: true).map(\.id) == ["finished", "approval"])
        precondition(TaskSidebarNavigation.visible(rows, now: now, expanded: [], selected: "running", workingShelfEnabled: true).map(\.id) == ["finished", "approval", "running"])
        precondition(TaskSidebarNavigation.visible(rows, now: now, expanded: ["working"], selected: nil, workingShelfEnabled: true).map(\.id) == ["finished", "approval", "running"])
        let token = UUID()
        let inbox = TaskSidebarDragPayload(token: token, taskID: "earlier", section: "active")
        precondition(TaskSidebarOrdering.plan(inbox, token: token, tasks: [finished, earlier], projectID: nil, section: .active, over: "finished", after: false, now: now, workingShelfEnabled: true) == nil, "Time-ordered inbox rows cannot be manually rearranged")
        let worker = TaskSidebarDragPayload(token: token, taskID: "running", section: "working")
        precondition(TaskSidebarOrdering.plan(worker, token: token, tasks: rows, projectID: nil, section: .pinned, over: nil, after: false, now: now, workingShelfEnabled: true) == nil)
        let pin = try task("pin", ["pinnedAt": at(1), "pinOrderKey": "n"])
        let pinPayload = TaskSidebarDragPayload(token: token, taskID: "pin", section: "pinned")
        let move = TaskSidebarOrdering.plan(pinPayload, token: token, tasks: rows + [pin], projectID: nil, section: .active, over: "approval", after: false, now: now, workingShelfEnabled: true, returnedAt: ["approval": observed])!
        precondition(move.body["workingShelfEnabled"] as? Bool == true)
        precondition((move.body["expected"] as? [[String: Any]])?.map { $0["id"] as? String } == ["approval", "finished"])
        print("Working partitions, human-send and return-time order, observed approvals, beta reset, service isolation, collapsed navigation and lifecycle-only drops passed")
    }
    static func multiSelection() throws {
        let ids = ["a", "b", "c", "d"]
        var selection = TaskSidebarSelection()
        selection.synchronize(context: "account:service", available: Set(ids))
        selection.activate("b"); selection.range(to: "d", ordered: ids)
        precondition(selection.selected == Set(["b", "c", "d"]) && selection.anchor == "b")
        precondition(selection.ordered == ["b", "c", "d"])
        selection.toggle("a"); selection.range(to: "c", ordered: ids)
        precondition(selection.selected == Set(ids) && selection.anchor == "a")
        selection.toggle("a"); precondition(selection.anchor == "a", "Toggling off retains the range anchor")
        selection.toggle("a"); precondition(selection.ordered == ["b", "c", "d", "a"])
        selection.toggle("a")
        selection.range(to: "d", ordered: ["c", "d"])
        precondition(selection.anchor == "d" && selection.selected == Set(["b", "c", "d"]))
        selection.remove(["b", "d"]); precondition(selection.selected == ["c"] && selection.anchor == nil)
        selection.synchronize(context: "account:service", available: ["a", "b"])
        precondition(selection.selected.isEmpty)
        selection.toggle("a"); selection.synchronize(context: "other-account:service", available: Set(ids))
        precondition(!selection.hasSelection && selection.anchor == nil)
        selection.activate("b"); precondition(!selection.hasSelection && selection.anchor == "b")
        selection.clear(); precondition(selection.anchor == nil)

        let origin: [String: Any] = ["rootTaskId": "parent", "parentTaskId": "parent", "subagentId": "child", "sessionId": "process", "threadId": "provider", "nativeId": "child"]
        let rows = try [task("a", ["pinnedAt": "2026-10-20T00:00:00Z", "canSnooze": true]),
            task("b", ["settledOverride": "settled", "titleGenerationSupported": true, "canSnooze": true]),
            task("c", ["titleGenerationSupported": true, "titleRegeneration": ["requestId": "running", "startedAt": "2026-10-20T00:00:00Z"], "canSnooze": true]),
            task("d", ["canSnooze": false]), task("archived", ["archivedAt": "2026-10-20T00:00:00Z"]),
            task("child", ["subagentOrigin": origin]), task("personal", ["agent": "friday"])]
        let bulk = TaskBulkSelection(tasks: rows, selected: Set(rows.map(\.id)))
        precondition(bulk.count == 4 && bulk.targets(.unpin).map(\.id) == ["a"])
        precondition(bulk.targets(.settle).map(\.id) == ["a", "c", "d"])
        precondition(bulk.titleSupported.count == 2 && bulk.targets(.regenerateTitle).map(\.id) == ["b"])
        precondition(!bulk.canSnooze && bulk.targets(.snooze).isEmpty)
        precondition(bulk.targets(.markUnread).count == 4 && bulk.targets(.delete).count == 4)
        precondition(TaskBulkSelection(tasks: rows, selected: ["a", "b"]).canSnooze)
        precondition(TaskBulkSelection(tasks: rows, selected: []).targets(.delete).isEmpty)
        precondition(TaskBulkSelection(tasks: rows, selected: ["a", "b"], ordered: ["b", "a"]).tasks.map(\.id) == ["b", "a"])
        let unread = try task("read-state", ["unread": true]), read = try task("read-state", ["unread": false])
        precondition(TaskSnooze.readIdentity(unread) == TaskSnooze.readIdentity(read), "Explicit unread does not re-trigger a visit in the already-open task")
        let plan = TaskBulkPlan(action: .regenerateTitle, tasks: bulk.regeneratable, context: "account:service")
        let first = plan.request(for: "b")!, retried = plan.request(for: "b")!
        precondition(first.method == "POST" && first.path == "/api/tasks/b/title/regenerate")
        precondition(first.body?["requestId"] as? String == retried.body?["requestId"] as? String)
        precondition(plan.request(for: "not-selected") == nil)
        precondition(TaskBulkPlan(action: .snooze, tasks: bulk.tasks, context: "account:service").request(for: "a") == nil)
        let snoozed = TaskBulkPlan(action: .snooze, tasks: bulk.tasks, context: "account:service", snoozedUntil: "2026-10-21T00:00:00Z").request(for: "a")!
        precondition(snoozed.body?["snoozedUntil"] as? String == "2026-10-21T00:00:00Z")
        let deletion = TaskBulkPlan(action: .delete, tasks: bulk.tasks, context: "account:service").request(for: "a")!
        precondition(deletion.method == "DELETE" && deletion.body == nil)
        print("Bulk selection, additive ranges, stale anchors, account isolation and action subsets passed")
    }

    @MainActor static func bulkRequests() async throws {
        enum Failure: Error { case fixture }
        let rows = try [task("a"), task("b"), task("c")]
        let coordinator = TaskBulkCoordinator()
        let deletion = TaskBulkPlan(action: .delete, tasks: rows, context: "account:service")
        var calls: [String] = []
        let partial = await coordinator.run(deletion, isCurrent: { true }) { request in
            calls.append(request.path)
            if request.path.hasSuffix("/b") { throw Failure.fixture }
        }!
        precondition(calls == ["/api/tasks/a", "/api/tasks/b", "/api/tasks/c"])
        precondition(partial.succeeded == Set(["a", "c"]) && Set(partial.failures.keys) == ["b"])
        let retried = await coordinator.run(deletion, isCurrent: { true }) { calls.append($0.path) }!
        precondition(calls.last == "/api/tasks/b" && calls.count == 4 && retried.succeeded.count == 3)
        let lostDeletion = TaskBulkPlan(action: .delete, tasks: rows, context: "account:service")
        _ = await coordinator.run(lostDeletion, isCurrent: { true }) { _ in throw Failure.fixture }
        coordinator.acknowledgeMissingDeletes(available: ["b"])
        precondition(coordinator.outcome.succeeded == ["a", "c"] && Set(coordinator.outcome.failures.keys) == ["b"], "A refreshed deletion snapshot resolves a lost reply without re-deleting missing tasks")

        let titles = TaskBulkPlan(action: .regenerateTitle, tasks: rows, context: "account:service")
        var titleCalls: [String] = [], requestIDs: [String] = []
        _ = await coordinator.run(titles, isCurrent: { true }) { request in
            titleCalls.append(request.path); requestIDs.append(request.body!["requestId"] as! String)
            if request.path.contains("/b/") { throw Failure.fixture }
        }
        precondition(titleCalls.count == 2 && !titleCalls.contains("/api/tasks/c/title/regenerate"))
        _ = await coordinator.run(titles, isCurrent: { true }) { request in
            titleCalls.append(request.path); requestIDs.append(request.body!["requestId"] as! String)
        }
        precondition(titleCalls.count == 4 && requestIDs[1] == requestIDs[2], "Retrying an uncertain title start preserves its receipt")
        let unread = TaskBulkPlan(action: .markUnread, tasks: rows, context: "old-account")
        var current = true; calls = []
        let retired = await coordinator.run(unread, isCurrent: { current }) { request in
            calls.append(request.path); current = false
        }
        precondition(retired == nil && calls.count == 1 && coordinator.plan == nil && !coordinator.busy)
        print("Bulk partial failure, failed-only retry, stable title receipts, stop-at-failure and connection retirement passed")
    }

}
