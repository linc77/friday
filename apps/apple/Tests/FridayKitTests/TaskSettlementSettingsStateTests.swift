import Foundation

@main struct TaskSettlementSettingsStateTests {
    static func snapshot(version: Int = 0, project: String? = nil, override: [String: Any] = [:], days: Any = 3) throws -> TaskSettlementSettingsSnapshot {
        let body: [String: Any] = ["version": version, "projectId": project as Any? ?? NSNull(), "defaults": ["sidebarAutoSettleAfterDays": 3],
            "overrides": override, "effective": ["sidebarAutoSettleAfterDays": days], "source": "host"]
        return try JSONDecoder().decode(TaskSettlementSettingsSnapshot.self, from: JSONSerialization.data(withJSONObject: body))
    }
    static func main() throws {
        var state = TaskSettlementSettingsState()
        let first = state.begin(identity: "account:service", projectID: nil)
        precondition(state.beginSave() == nil)
        let host = try snapshot(); precondition(state.accept(host, token: first, identity: "account:service"))
        precondition(host.effective.sidebarAutoSettleAfterDays == 3 && !host.overrides.hasDaysOverride)
        let save = state.beginSave(ownerToken: first)!
        precondition(state.beginSave(ownerToken: first) == nil && !state.shouldReload(1))
        let project = state.begin(identity: "account:service", projectID: "workspace")
        let disabled = try snapshot(version: 1, project: "workspace", override: ["sidebarAutoSettleAfterDays": NSNull()], days: NSNull())
        precondition(!state.accept(host, token: save, identity: "account:service"))
        precondition(state.accept(disabled, token: project, identity: "account:service"))
        precondition(state.snapshot!.overrides.hasDaysOverride && state.snapshot!.effective.sidebarAutoSettleAfterDays == nil, "Explicitly disabled differs from inheriting the host")
        precondition(state.beginSave(ownerToken: first) == nil, "An old field blur or toggle cannot save into another scope")
        let stale = try snapshot(project: "workspace"); precondition(!state.accept(stale, token: project, identity: "account:service"))
        precondition(state.shouldReload(2))
        let newer = state.begin(identity: "account:new-service", projectID: nil)
        precondition(!state.finish(project, identity: "account:service"))
        precondition(state.accept(host, token: newer, identity: "account:new-service"))
        let decimal = try snapshot(days: 1.5); precondition(decimal.effective.sidebarAutoSettleAfterDays == 1.5, "T3 accepts fractional API values even though the input control commits whole days")
        print("Auto-settle default/null inheritance, versioned saves, old field callbacks, scope and service isolation passed")
    }
}
