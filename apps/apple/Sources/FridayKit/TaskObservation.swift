import Observation

/// Detail streams invalidate only readers of that task, independently of the
/// overview list. Tokens contain no task bodies and do not extend history lifetimes.
@MainActor
final class TaskObservation {
    @Observable fileprivate final class Token { var revision = 0 }
    private var tokens: [String: Token] = [:]

    func revision(_ id: String) -> Int {
        let token: Token
        if let existing = tokens[id] { token = existing }
        else { token = Token(); tokens[id] = token }
        return token.revision
    }

    func invalidate(_ ids: Set<String>) {
        for id in ids { tokens[id]?.revision += 1 }
    }

    func invalidateAll() {
        for token in tokens.values { token.revision += 1 }
    }
}
