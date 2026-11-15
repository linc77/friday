import Foundation

/// Only our acknowledged writes can advance an editor's stale base version.
/// A newer snapshot alone is never evidence that it is safe to overwrite it.
struct NoteSyncState {
    private struct Version: Hashable { let value: String? }
    private var scope = ""
    private var acknowledgements: [String: [Version: String]] = [:]

    mutating func useScope(_ scope: String) {
        guard self.scope != scope else { return }
        self.scope = scope
        acknowledgements = [:]
    }

    func version(for id: String, basedOn version: String?) -> String? {
        var current = version
        var visited = Set<Version>()
        while visited.insert(Version(value: current)).inserted,
              let next = acknowledgements[id]?[Version(value: current)] {
            current = next
        }
        return current
    }

    func enqueue(_ draft: OutboxIdea, replacing previous: OutboxIdea?) -> OutboxIdea {
        var draft = draft
        draft.expectedUpdatedAt = previous != nil ? previous?.expectedUpdatedAt
            : version(for: draft.id, basedOn: draft.expectedUpdatedAt)
        draft.pendingUpload = previous?.pendingUpload
        return draft
    }

    static func preparing(_ draft: OutboxIdea) -> OutboxIdea {
        var draft = draft
        if draft.pendingUpload == nil {
            draft.pendingUpload = NoteUpload(note: draft.note, editId: draft.editId ?? draft.id, expectedUpdatedAt: draft.expectedUpdatedAt)
        }
        return draft
    }

    static func imageIDs(in pending: [OutboxIdea]) -> Set<String> {
        Set(pending.flatMap { (($0.images ?? []) + ($0.pendingUpload?.note.images ?? [])).map(\.id) })
    }

    static func sameContent(_ saved: Idea, _ submitted: Idea) -> Bool {
        saved.text == submitted.text.trimmingCharacters(in: .whitespacesAndNewlines)
            && (saved.title ?? "") == (submitted.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            && (saved.images ?? []) == (submitted.images ?? [])
    }

    mutating func acknowledge(_ upload: NoteUpload, saved: Idea) {
        guard saved.id == upload.note.id, Self.sameContent(saved, upload.note) else { return }
        acknowledgements[saved.id, default: [:]][Version(value: upload.expectedUpdatedAt)] = saved.updatedAt ?? saved.createdAt
    }

    static func remaining(_ current: OutboxIdea, after upload: NoteUpload, saved: Idea) -> OutboxIdea? {
        guard current.pendingUpload == upload else { return current }
        if (current.editId ?? current.id) == upload.editId && sameContent(saved, current.note) { return nil }
        var next = current
        next.expectedUpdatedAt = saved.updatedAt ?? saved.createdAt
        next.pendingUpload = nil
        return next
    }
}

/// Failed notes stay durable, but are attempted at most once in this pass.
struct NoteSyncPass {
    private var failed = Set<String>()
    private(set) var error: String?

    func next(in outbox: [OutboxIdea], noteID: String? = nil) -> OutboxIdea? {
        outbox.first { !failed.contains($0.id) && (noteID == nil || $0.id == noteID) }
    }
    mutating func fail(_ id: String, message: String) {
        failed.insert(id)
        if error == nil { error = message }
    }
}

/// Upload failures belong to the pending note, never to an unrelated chat.
struct NoteSyncErrors {
    private var scope = ""
    private var messages: [String: String] = [:]

    subscript(_ id: String) -> String? {
        get { messages[id] }
        set { messages[id] = newValue }
    }
    mutating func useScope(_ scope: String) {
        guard self.scope != scope else { return }
        self.scope = scope
        messages = [:]
    }
    mutating func retain(_ pending: [OutboxIdea]) {
        let ids = Set(pending.map(\.id))
        messages = messages.filter { ids.contains($0.key) }
    }
}
