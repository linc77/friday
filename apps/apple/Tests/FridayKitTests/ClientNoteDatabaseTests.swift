import Foundation
import CryptoKit
import SQLite3

@main
struct ClientNoteDatabaseTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("friday-note-db-\(UUID())", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("notes.sqlite")
        let image = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=")!
        let id = SHA256.hash(data: image).map { String(format: "%02x", $0) }.joined()
        let first = Data(#"[{"id":"offline","text":"未同步的正文","editId":"stable-request"}]"#.utf8)
        var database: ClientNoteDatabase? = try ClientNoteDatabase(url: url)
        try database!.storeImage(image, id: id)
        try database!.storeImage(image, id: id)
        try database!.replaceOutbox(first, imageIDs: [id])
        database = nil
        let reopened = try ClientNoteDatabase(url: url)
        let restoredDraft = try reopened.outbox()
        precondition(restoredDraft == first, "Draft text and request IDs survive restart")
        let restoredImage = try reopened.image(id)
        precondition(restoredImage == image, "Original bytes survive without a separate image directory")
        do {
            try reopened.replaceOutbox(Data("replacement".utf8), imageIDs: [id, "missing"])
            preconditionFailure("Missing local originals must reject the transaction")
        } catch ClientNoteDatabase.Failure.missingImage {}
        let rolledBackDraft = try reopened.outbox()
        precondition(rolledBackDraft == first, "Failure keeps the previously committed draft")
        var raw: OpaquePointer?
        precondition(sqlite3_open(url.path, &raw) == SQLITE_OK)
        defer { sqlite3_close(raw) }
        sqlite3_exec(raw, "PRAGMA foreign_keys=ON", nil, nil, nil)
        precondition(sqlite3_exec(raw, "DELETE FROM assets", nil, nil, nil) == SQLITE_CONSTRAINT, "Pending notes keep their image pins even after a failed save")
        do { try reopened.storeImage(Data("corrupt".utf8), id: id); preconditionFailure("Reject mismatched content hashes") }
        catch ClientNoteDatabase.Failure.invalidImage {}
        try reopened.replaceOutbox(Data("remote edit".utf8), imageIDs: [id, "host-image"], knownRemoteIDs: ["host-image"])
        try reopened.replaceOutbox(Data("offline follow-up".utf8), imageIDs: [id, "host-image"])
        let offlineDraft = try reopened.outbox()
        precondition(offlineDraft == Data("offline follow-up".utf8), "Remote references remain identifiable across offline edits")
        try reopened.replaceOutbox(Data("[]".utf8), imageIDs: [])
        precondition(sqlite3_exec(raw, "DELETE FROM assets", nil, nil, nil) == SQLITE_OK, "Acknowledgement releases note pins")
        do { try reopened.replaceOutbox(first, imageIDs: ["host-image"]); preconditionFailure("Cleared remote evidence must not authorize future missing images") }
        catch ClientNoteDatabase.Failure.missingImage {}
        let clearedDraft = try reopened.outbox()
        precondition(clearedDraft == Data("[]".utf8))
        print("Client note SQLite restart, rollback, image integrity and pin checks passed")
    }
}
