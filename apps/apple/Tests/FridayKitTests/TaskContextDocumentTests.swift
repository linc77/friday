import Foundation

@main
struct TaskContextDocumentTests {
    static func reference(_ id: String, kind: String = "file", label: String = "src/中文 [file].ts", digest: String = "captured-digest") throws -> TaskContextReference {
        let object: [String: Any] = ["id": id, "kind": kind, "label": label, "capturedAt": "2026-10-18T03:00:00Z", "digest": digest, "byteLength": 12]
        return try JSONDecoder().decode(TaskContextReference.self, from: JSONSerialization.data(withJSONObject: object))
    }
    static func main() throws {
        let ordinaryScope = TaskContextScope(projectID: "p")
        let preparedScope = TaskContextScope(projectID: "p", preparationID: "00000000-0000-0000-0000-000000000001")
        precondition(ordinaryScope.body["preparationId"] == nil && preparedScope.body["preparationId"] as? String == preparedScope.preparationID)
        precondition(preparedScope.identity != ordinaryScope.identity && preparedScope.query.contains("preparationId="))
        let ref = try reference("file_1"); let quote = try reference("terminal_2", kind: "terminal", label: "Terminal 1:3-8")
        let token = TaskContextDocument.token(ref); precondition(!token.contains("[file]"))
        let text = "😀中 " + token + " after " + TaskContextDocument.token(quote)
        let occurrences = TaskContextDocument.occurrences(text); precondition(occurrences.count == 2 && occurrences[0].range.location == 4)
        precondition(TaskContextDocument.used(text + token, records: [ref, quote]).map(\.id) == ["file_1", "terminal_2"])
        precondition(!TaskContextDocument.missing(text, records: [ref, quote]) && TaskContextDocument.missing(text, records: [ref]))
        precondition(TaskContextDocument.plain(text).hasPrefix("😀中 @src/中文 file .ts after"))
        precondition(TaskContextDocument.referenceID(URL(string: "friday-context://v1/file/file_1")!) == "file_1")
        precondition(TaskContextDocument.referenceID(URL(string: "https://example.test/file/file_1")!) == nil)
        precondition(TaskContextDocument.modelOffset(4, in: text) == 4)
        precondition(TaskContextDocument.modelOffset(5, in: text) == 4 + token.utf16.count)
        precondition(TaskContextDocument.viewOffset(4 + token.utf16.count, in: text) == 5)
        for position in [0, 2, 3, 4, 4 + token.utf16.count, text.utf16.count] {
            precondition(TaskContextDocument.modelOffset(TaskContextDocument.viewOffset(position, in: text), in: text) == position)
        }
        let typed = "before @src/中文 after"; let caret = ("before @src/中文" as NSString).length
        let query = TaskContextDocument.mention(in: "before @src/中文", at: caret)!
        precondition(query.text == "src/中文" && query.source == "@src/中文")
        precondition(TaskContextDocument.mention(in: "email@example.test", at: 18) == nil)
        precondition(TaskContextDocument.mention(in: "@@literal", at: 9) == nil)
        precondition(TaskContextDocument.mention(in: text, at: 4 + token.utf16.count - 1) == nil)
        let insertion = TaskContextInsertion(reference: ref, replacing: query)
        precondition(TaskContextDocument.insertionRange(insertion, text: typed, caret: NSRange(location: typed.utf16.count, length: 0)) == query.range)
        let updated = "USER CHANGED " + typed
        let current = NSRange(location: updated.utf16.count, length: 0)
        precondition(TaskContextDocument.insertionRange(insertion, text: updated, caret: current) == current, "A late capture must preserve the updated prompt and insert at its current caret")
        let legacyDraft = Data(#"{"message":"Draft","images":[],"requestId":"original"}"#.utf8)
        let legacy = try JSONDecoder().decode(TaskMessageDraft.self, from: legacyDraft); precondition(legacy.contexts == nil)
        let saved = TaskMessageDraft(message: text, images: [], requestId: "with-context", contexts: [ref, quote])
        let restored = try JSONDecoder().decode(TaskMessageDraft.self, from: JSONEncoder().encode(saved))
        precondition(restored.contexts?.map(\.id) == [ref.id, quote.id] && restored.message == text)
        let pending = TaskContextInsertion(reference: ref, replacing: query, identity: "http://host\ntask:one", previousOccurrences: 1)
        let queuedDraft = TaskMessageDraft(message: typed, images: [], requestId: "queued-insert", contexts: [ref], contextInsertion: pending)
        let recovered = try JSONDecoder().decode(TaskMessageDraft.self, from: JSONEncoder().encode(queuedDraft))
        precondition(recovered.contextInsertion == pending, "A pending insertion keeps its scope and one-shot identity across reloads")
        precondition(recovered.contextInsertion?.identity != "http://host\ntask:two", "A pending reference must never enter another task's editor")
        var attachment = try reference("ordinary-file", kind: "attachment", label: "报告.pdf")
        attachment.attachmentName = "报告.pdf"; attachment.mediaType = "application/pdf"
        let attachmentDraft = TaskMessageDraft(message: TaskContextDocument.token(attachment), images: [], requestId: "file-draft", contexts: [attachment])
        let fileRoundTrip = try JSONDecoder().decode(TaskMessageDraft.self, from: JSONEncoder().encode(attachmentDraft))
        precondition(fileRoundTrip.contexts?.first?.attachmentName == "报告.pdf" && fileRoundTrip.contexts?.first?.mediaType == "application/pdf")
        let hundred = try (0..<100).map { try reference("file_\($0)", kind: "attachment", label: "\($0).txt", digest: "digest-\($0)") }
        precondition(TaskContextDocument.batch(hundred, text: "draft", records: [], identity: "composer")?.insertion.additional?.count == 99)
        precondition(TaskContextDocument.batch(hundred + [attachment], text: "draft", records: [], identity: "composer") == nil)
        print("Context reference ids, UTF-16 caret mapping, mention boundaries, late insertion, expired references and draft compatibility passed")
    }
}
