import Foundation

@main
struct TaskQueueTests {
    static func main() throws {
        for preference in ["queue", "steer"] {
            for alternate in [false, true] {
                precondition(TaskComposerDispatch.resolve(running: false, canSteer: false, preference: preference, alternate: alternate) == .auto)
                precondition(TaskComposerDispatch.resolve(running: true, canSteer: false, preference: preference, alternate: alternate) == .queue,
                             "A connecting or non-steerable run always retains input in the queue")
            }
        }
        precondition(TaskComposerDispatch.resolve(running: true, canSteer: true, preference: "queue", alternate: false) == .queue)
        precondition(TaskComposerDispatch.resolve(running: true, canSteer: true, preference: "queue", alternate: true) == .steer)
        precondition(TaskComposerDispatch.resolve(running: true, canSteer: true, preference: "steer", alternate: true) == .queue)
        precondition(TaskComposerDispatch.resolve(running: true, canSteer: true, preference: "steer", alternate: false) == .steer)
        let queueJSON = #"{"dispatcherId":12,"paused":false,"messages":[{"id":"one","text":"Later","images":[],"createdAt":"2026-10-17T12:00:00Z","status":"queued"},{"id":"sent","text":"Already started","images":[],"createdAt":"2026-10-17T12:00:00Z","status":"running"},{"id":"steering","text":"Sending","images":[],"createdAt":"2026-10-17T12:00:00Z","status":"steering"}]}"#
        let queue = try JSONDecoder().decode(TaskMessageQueue.self, from: Data(queueJSON.utf8))
        precondition(queue.pending.map(\.id) == ["one", "steering"], "The currently executing turn never reappears as a future queued message")
        precondition(queue.pending[0].editable && !queue.pending[1].editable)
        let oldDraft = try JSONDecoder().decode(TaskMessageDraft.self, from: Data(#"{"message":"Unsent draft","images":[],"requestId":"old"}"#.utf8))
        precondition(oldDraft.queueEdit == nil)
        precondition(oldDraft.interactionMode == nil)
        let editing = TaskMessageDraft(message: "Edited queued text", images: [], requestId: "edit",
            queueEdit: QueuedMessageEditDraft(id: "one", message: oldDraft.message, images: oldDraft.images, requestId: oldDraft.requestId, interactionMode: "default"), interactionMode: "plan")
        let restored = try JSONDecoder().decode(TaskMessageDraft.self, from: JSONEncoder().encode(editing))
        precondition(restored.message == "Edited queued text" && restored.queueEdit?.message == "Unsent draft" && restored.queueEdit?.requestId == "old",
                     "Editing a queued message preserves both the edits and the previous unsent draft across restarts")
        precondition(restored.interactionMode == "plan" && restored.queueEdit?.interactionMode == "default", "A queued Plan-mode edit restores the unsent draft's original interaction mode")
        var rewinding = oldDraft
        rewinding.rewindEdit = TaskRewindDraft(requestId: "rewind-request", applied: false, original: TaskComposerDraftBackup(message: oldDraft.message, images: oldDraft.images, requestId: oldDraft.requestId, interactionMode: "plan"))
        let restoredRewind = try JSONDecoder().decode(TaskMessageDraft.self, from: JSONEncoder().encode(rewinding))
        precondition(restoredRewind.rewindEdit?.requestId == "rewind-request" && restoredRewind.rewindEdit?.applied == false)
        precondition(restoredRewind.rewindEdit?.original.message == "Unsent draft" && restoredRewind.rewindEdit?.original.requestId == "old", "A pending rewind retains its request identity and the previous unsent draft across restarts")
        let legacyTask = #"{"id":"task","title":"Title","prompt":"Question","projectId":null,"cwd":"/tmp","agent":"codex","mode":"research","status":"completed","createdAt":"2026-10-17T10:00:00Z","updatedAt":"2026-10-17T11:00:00Z","durableId":1,"threadId":"thread","turnId":"old","result":"Answer","error":null,"events":[],"approvals":[],"artifact":null}"#
        var payload = try JSONSerialization.jsonObject(with: Data(legacyTask.utf8)) as! [String: Any]
        let legacy = try JSONDecoder().decode(WorkItem.self, from: Data(legacyTask.utf8))
        precondition(!legacy.active && legacy.queue == nil && legacy.canSteer == nil)
        payload["queue"] = try JSONSerialization.jsonObject(with: Data(queueJSON.utf8))
        let draining = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        precondition(draining.active && draining.activityStatus == "queued", "The scheduler gap between two turns remains visible as Working")
        precondition(CodexTranscript.date("2026-10-17T12:00:00Z") == TaskRowPresentation.runningStart(draining), "A waiting queue uses its new request time, not an old turn's clock")
        payload.removeValue(forKey: "queue")
        payload["status"] = "failed"; payload["currentRunId"] = "run"
        var run: [String: Any] = ["id": "run", "durableId": 7, "messageId": "user", "requestId": "original", "cwd": "/tmp", "at": "2026-10-17T09:00:00Z", "status": "failed", "mode": "code", "interactionMode": "default",
            "workspacePreparation": ["status": "failed", "attempt": 2, "startedAt": "2026-10-17T12:00:00Z", "error": "Git failed"]]
        payload["runs"] = [run]
        var preparation = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        precondition(preparation.preparationFailure?.id == "run" && preparation.canRetryPreparation(preparation.runs![0]))
        run["inheritedFrom"] = ["taskId": "parent", "runId": "source"]
        payload["runs"] = [run]
        preparation = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        precondition(!preparation.canRetryPreparation(preparation.runs![0]), "Inherited preparation failures do not control the parent's execution")
        run.removeValue(forKey: "inheritedFrom")
        run["status"] = "queued"; run["workspacePreparation"] = ["status": "preparing", "attempt": 3, "startedAt": "2026-10-17T12:00:00Z"]
        payload["status"] = "running"; payload.removeValue(forKey: "turnId"); payload["runs"] = [run]
        preparation = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        precondition(preparation.preparationFailure == nil && preparation.preparingWorkspace?.attempt == 3)
        precondition(CodexTranscript.date("2026-10-17T12:00:00Z") == TaskRowPresentation.runningStart(preparation), "Retry clocks exclude the wait since the original message")
        run["startedAt"] = "2026-10-17T12:05:00Z"; run["workspacePreparation"] = ["status": "ready", "attempt": 3, "startedAt": "2026-10-17T12:00:00Z"]; payload["runs"] = [run]
        preparation = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        precondition(preparation.preparingWorkspace == nil && preparation.preparationFailure == nil)
        precondition(CodexTranscript.date("2026-10-17T12:05:00Z") == TaskRowPresentation.runningStart(preparation), "Agent work starts after workspace preparation")
        print("Queue dispatch modifiers, readiness, queued projection, edit-draft recovery, legacy snapshots and scheduling-gap activity passed")
    }
}
