import Foundation

// Every request belongs to the connection, service incarnation and settings
// scope that created it. Returning to an old scope does not revive its callback.
struct ScopedSettingsState<Value: ScopedSettingsSnapshot> {
    private(set) var identity = ""
    private(set) var projectID: String?
    private(set) var token = UUID()
    private(set) var snapshot: Value?
    private(set) var busy = false

    mutating func begin(identity: String, projectID: String?) -> UUID {
        self.identity = identity; self.projectID = projectID; token = UUID(); snapshot = nil; busy = true; return token
    }
    func current(_ token: UUID, identity: String, projectID: String?) -> Bool {
        self.token == token && self.identity == identity && self.projectID == projectID
    }
    @discardableResult mutating func accept(_ value: Value, token: UUID, identity: String) -> Bool {
        guard current(token, identity: identity, projectID: value.projectId), value.version >= 0,
              snapshot == nil || value.version >= snapshot!.version else { return false }
        snapshot = value; busy = false; return true
    }
    mutating func beginSave(ownerToken: UUID? = nil) -> UUID? {
        guard snapshot != nil, !busy, ownerToken == nil || ownerToken == token else { return nil }
        token = UUID(); busy = true; return token
    }
    mutating func finish(_ token: UUID, identity: String) -> Bool {
        guard current(token, identity: identity, projectID: projectID) else { return false }
        busy = false; return true
    }
    func shouldReload(_ knownVersion: Int?) -> Bool {
        guard !busy, let version = snapshot?.version, let knownVersion else { return false }
        return knownVersion > version
    }
}
typealias TextGenerationSettingsState = ScopedSettingsState<TextGenerationSettingsSnapshot>
typealias TaskSettlementSettingsState = ScopedSettingsState<TaskSettlementSettingsSnapshot>
