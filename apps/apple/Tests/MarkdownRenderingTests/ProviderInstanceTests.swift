import XCTest
@testable import FridayKit

final class ProviderInstanceTests: XCTestCase {
    func testLegacyAndBoundTaskInstancesSurviveSnapshotRoundTrips() throws {
        var source: [String: Any] = ["id": "task", "title": "Task", "prompt": "Hello", "cwd": "/tmp", "agent": "codex", "mode": "code", "status": "completed", "createdAt": "2026-10-23T00:00:00Z", "updatedAt": "2026-10-23T00:00:00Z", "result": "Hello", "events": [], "approvals": []]
        let legacy = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: source))
        XCTAssertEqual(legacy.resolvedProviderInstance, "codex")
        source["providerInstanceId"] = "codex_work"
        let bound = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: source))
        let decoded = try JSONDecoder().decode(WorkItem.self, from: JSONEncoder().encode(bound))
        XCTAssertEqual(decoded.resolvedProviderInstance, "codex_work")
    }
    func testRetiredTaskIdentityRemainsReadableWithoutOfferingItForNewTasks() throws {
        XCTAssertEqual(TaskProviderCatalog.order, ["codex", "claude", "pi"])
        for agent in ["opencode", "grok", "muse", "cursor", "antigravity", "acp-registry"] {
            let source: [String: Any] = ["id": "old", "title": "Old task", "prompt": "Original", "cwd": "/tmp", "agent": agent, "providerInstanceId": agent + "_old", "mode": "code", "status": "completed", "createdAt": "2026-10-23T00:00:00Z", "updatedAt": "2026-10-23T00:00:00Z", "result": "Saved answer", "events": [], "approvals": []]
            let task = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: source))
            let restored = try JSONDecoder().decode(WorkItem.self, from: JSONEncoder().encode(task))
            XCTAssertEqual(restored.agent, agent)
            XCTAssertEqual(restored.resolvedProviderInstance, agent + "_old")
            XCTAssertEqual(restored.result, "Saved answer")
            XCTAssertFalse(TaskProviderCatalog.order.contains(agent))
        }
    }
    func testNativeEndpointsAppendInstanceAfterActionAndModelChoicesHaveIndependentIdentities() {
        XCTAssertEqual(TaskProviderCatalog.endpoint("codex", instance: "codex_work", path: "/check"), "/api/agents/codex/check?instanceId=codex_work")
        let model = CodexProviderModel(id: "same-model", name: "Same", description: "", isDefault: true, reasoningEfforts: [], defaultReasoningEffort: "")
        let first = TaskModelChoice(provider: "codex", model: model, instanceId: "codex_work"), second = TaskModelChoice(provider: "codex", model: model, instanceId: "codex_personal")
        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(first.provider, second.provider)
    }
    func testNativeOptionValuesRetainFalseThroughSnapshotAndRequestEncoding() throws {
        let data = Data("[{\"id\":\"fastMode\",\"value\":false},{\"id\":\"contextWindow\",\"value\":\"1m\"}]".utf8)
        let options = try JSONDecoder().decode([ProviderOptionSelection].self, from: data)
        XCTAssertEqual(options[0].value, .flag(false))
        XCTAssertEqual(options[0].body["value"] as? Bool, false)
        XCTAssertEqual(try JSONDecoder().decode([ProviderOptionSelection].self, from: JSONEncoder().encode(options)), options)
        let descriptor = try JSONDecoder().decode(ProviderOptionDescriptor.self, from: Data("{\"id\":\"fastMode\",\"label\":\"Fast\",\"type\":\"boolean\",\"currentValue\":false}".utf8))
        XCTAssertEqual(descriptor.currentValue, .flag(false))
    }
    func testUnmeteredAccountAvailabilityIsDistinctFromMissingQuotaData() throws {
        let available = try JSONDecoder().decode(TaskProviderUsageLimits.self, from: Data("{\"checkedAt\":\"2026-10-24T00:00:00Z\",\"windows\":[],\"available\":true}".utf8))
        let unknown = try JSONDecoder().decode(TaskProviderUsageLimits.self, from: Data("{\"checkedAt\":\"2026-10-24T00:00:00Z\",\"windows\":[]}".utf8))
        XCTAssertTrue(available.offered)
        XCTAssertFalse(unknown.offered)
    }
}
