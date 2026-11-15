import Foundation
import CryptoKit

@main
struct NoteSyncStateTests {
    static func draft(_ text: String, version: String? = "v0", edit: String = UUID().uuidString, id: String = "note", images: [IdeaImage] = []) -> OutboxIdea {
        OutboxIdea(id: id, text: text, title: "title", createdAt: "created", images: images, expectedUpdatedAt: version, editId: edit)
    }
    static func saved(_ upload: NoteUpload, version: String) -> Idea {
        Idea(id: upload.note.id, text: upload.note.text.trimmingCharacters(in: .whitespacesAndNewlines), createdAt: upload.note.createdAt, taskId: nil, title: upload.note.title, updatedAt: version, images: upload.note.images)
    }

    static func main() throws {
        // Reproduce an editor still holding 10:19:35 after multiple successful
        // uploads have drained the queue. A stale SSE snapshot must not undo
        // the versions proven by this device's upload acknowledgements.
        var state = NoteSyncState()
        state.useScope("host-one")
        for (index, text) in ["frot", "fro", "front", "frontier"].enumerated() {
            let next = state.enqueue(draft(text), replacing: nil)
            precondition(next.expectedUpdatedAt == "v\(index)")
            let upload = NoteSyncState.preparing(next).pendingUpload!
            state.acknowledge(upload, saved: saved(upload, version: "v\(index + 1)"))
        }
        let final = state.enqueue(draft("frontiercode 2.0\n"), replacing: nil)
        precondition(final.expectedUpdatedAt == "v4", "Continuous typing follows this device's acknowledged writes")
        precondition(state.version(for: "other-note", basedOn: "v0") == "v0")
        precondition(state.version(for: "note", basedOn: "other-device-version") == "other-device-version")
        // If another device has since written v5, we still submit against v4,
        // allowing the server to reject it rather than overwriting v5.
        precondition(state.version(for: "note", basedOn: "v0") != "v5")
        let offline = state.enqueue(draft("offline", version: "external-base"), replacing: nil)
        let stillOffline = state.enqueue(draft("more offline", version: "v0"), replacing: offline)
        precondition(stillOffline.expectedUpdatedAt == "external-base", "Pending offline edits retain their original conflict boundary")
        let unrelated = NoteSyncState.preparing(draft("my content", version: "external-base")).pendingUpload!
        let differentContent = Idea(id: "note", text: "someone else's content", createdAt: "created", taskId: nil, title: "title", updatedAt: "external-new", images: [])
        state.acknowledge(unrelated, saved: differentContent)
        precondition(state.version(for: "note", basedOn: "external-base") == "external-base", "A different server payload is not proof of our successful write")

        var freshState = NoteSyncState()
        let create = NoteSyncState.preparing(draft("new", version: nil))
        freshState.acknowledge(create.pendingUpload!, saved: saved(create.pendingUpload!, version: "created-v1"))
        precondition(freshState.enqueue(draft("newer", version: nil), replacing: nil).expectedUpdatedAt == "created-v1")

        // The first request may have committed even though its response was
        // lost. Typing and restarting must preserve its original body and key.
        let bytes = Data("original-image".utf8)
        let imageID = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let image = IdeaImage(id: imageID, name: "original.png", mediaType: "image/png")
        let original = NoteSyncState.preparing(draft("frontier", edit: "first-request", images: [image]))
        let newer = freshState.enqueue(draft("frontiercode 2.0", edit: "second-request"), replacing: original)
        precondition(newer.pendingUpload == original.pendingUpload)
        precondition(newer.expectedUpdatedAt == "v0")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("friday-note-sync-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("notes.sqlite")
        var database: ClientNoteDatabase? = try ClientNoteDatabase(url: url)
        try database!.storeImage(bytes, id: imageID)
        try database!.replaceOutbox(JSONEncoder().encode([newer]), imageIDs: NoteSyncState.imageIDs(in: [newer]))
        database = nil
        let reopened = try ClientNoteDatabase(url: url)
        let restored = try JSONDecoder().decode([OutboxIdea].self, from: reopened.outbox()!).first!
        let replay = NoteSyncState.preparing(restored).pendingUpload!
        precondition(replay == original.pendingUpload, "Retry the exact request across process death")
        precondition(NoteSyncState.imageIDs(in: [restored]) == [imageID], "An image removed by later typing stays pinned for the uncertain upload")
        let retainedBytes = try reopened.image(imageID)
        precondition(retainedBytes == bytes)
        let firstAck = saved(replay, version: "v1")
        let remaining = NoteSyncState.remaining(restored, after: replay, saved: firstAck)!
        precondition(remaining.text == "frontiercode 2.0" && remaining.editId == "second-request")
        precondition(remaining.expectedUpdatedAt == "v1" && remaining.pendingUpload == nil)
        let followup = NoteSyncState.preparing(remaining)
        precondition(followup.pendingUpload!.editId == "second-request")
        precondition(NoteSyncState.remaining(followup, after: followup.pendingUpload!, saved: saved(followup.pendingUpload!, version: "v2")) == nil)
        precondition(NoteSyncState.remaining(followup, after: replay, saved: firstAck) == followup, "An obsolete acknowledgement cannot remove a different upload")

        var queue = [draft("conflict", id: "conflict"), draft("bad image", id: "image"), draft("healthy", id: "healthy")]
        let originalQueue = queue
        var pass = NoteSyncPass()
        precondition(pass.next(in: queue)?.id == "conflict")
        pass.fail("conflict", message: "409 conflict")
        precondition(pass.next(in: queue)?.id == "image")
        pass.fail("image", message: "image upload failed")
        precondition(pass.next(in: queue)?.id == "healthy")
        queue.removeAll { $0.id == "healthy" }
        precondition(pass.next(in: queue) == nil, "Do not spin on a failed note")
        precondition(queue == Array(originalQueue.prefix(2)), "Failures must preserve both drafts")
        precondition(pass.error == "409 conflict")
        precondition(NoteSyncPass().next(in: queue)?.id == "conflict", "A later pass retries retained notes")

        let legacy = try JSONDecoder().decode([OutboxIdea].self, from: Data(#"[{"id":"legacy","text":"offline","editId":"stable-key"}]"#.utf8))
        precondition(legacy[0].pendingUpload == nil)
        precondition(NoteSyncState.preparing(legacy[0]).pendingUpload?.editId == "stable-key")
        state.useScope("other-host")
        precondition(state.version(for: "note", basedOn: "v0") == "v0", "Acknowledgements cannot leak between connections")
        print("Note sync: continuous edits, exact replay after restart, image pins, conflict isolation and legacy decoding passed")
    }
}
