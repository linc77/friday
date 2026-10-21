import Foundation

@main
struct TaskChangeRequestTests {
    static func main() throws {
        let sha = String(repeating: "a", count: 40)
        let line = TaskRemoteReviewDraft(id: UUID(), path: "new.ts", oldPath: "old.ts", position: TaskChangeRequestPosition(kind: "context", newLine: 8, oldLine: 7, side: "left"), selection: TaskDiffReviewSelection(start: 7, side: "deletions", end: 7, endSide: "deletions"), headSha: sha, body: "  Keep indent\n")
        var draft = TaskChangeRequestDraft(summary: "Sent summary", comment: "  Comment body\n", verdict: "approve", comments: [line])
        let sent = TaskChangeRequestSubmission(url: "https://gitlab.com/group/sub/project/-/merge_requests/17", headSha: sha, action: "review", mergeMethod: nil, draft: draft)
        let data = try JSONSerialization.data(withJSONObject: sent.body)
        let body = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        precondition(body["body"] as? String == "Sent summary")
        let comment = (body["comments"] as! [[String: Any]])[0]
        precondition(comment["oldPath"] as? String == "old.ts")
        precondition(comment["body"] as? String == "  Keep indent\n")
        precondition((comment["position"] as! [String: Any])["side"] as? String == "left")
        let later = TaskRemoteReviewDraft(id: UUID(), path: "later.ts", oldPath: nil, position: TaskChangeRequestPosition(kind: "added", newLine: 1), selection: line.selection, headSha: sha, body: "Added after sending")
        draft.summary = "Typed while sending"; draft.comments.append(later)
        draft.reconcile(sent)
        precondition(draft.summary == "Typed while sending" && draft.comments == [later])
        precondition(draft.comment == "  Comment body\n")
        let sentComment = TaskChangeRequestSubmission(url: sent.url, headSha: sha, action: "comment", mergeMethod: nil, draft: draft)
        draft.reconcile(sentComment); precondition(draft.comment.isEmpty && draft.summary == "Typed while sending")
        var unchanged = sent.draft; unchanged.reconcile(sent); precondition(unchanged.summary.isEmpty && unchanged.comments.isEmpty)
        let operation = try JSONDecoder().decode(TaskChangeRequestOperation.self, from: Data(#"{"id":"receipt","url":"https://github.com/fixture/project/pull/17","action":"review","status":"interrupted","createdAt":"2026-10-19","updatedAt":"2026-10-19","completedEffects":["inline-0","summary"],"error":"Verify remotely"}"#.utf8))
        precondition(!operation.active && operation.completedEffects.count == 2)
        let detail = try JSONDecoder().decode(TaskChangeRequestDetail.self, from: Data(#"{"pullRequest":{"number":17,"url":"https://gitlab.com/group/sub/project/-/merge_requests/17","title":"Fixture","state":"open","base":"main","head":"feature","provider":"gitlab"},"body":"Description","author":"reviewer","createdAt":"","updatedAt":"","isDraft":false,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mergeability":"unknown","actions":["close"],"mergeMethods":["merge"],"verdicts":["comment","approve"],"canComment":true,"reviewers":[],"labels":[],"checks":[]}"#.utf8))
        precondition(detail.term == "MR" && detail.mergeQueue == nil && !detail.verdicts.contains("request-changes"))
        precondition(detail.autoMergeEnabled == nil && detail.behindBy == nil && detail.updateMethods == nil)
        var advancedJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(operation)) as! [String: Any]
        advancedJSON["resultURL"] = "https://github.com/fixture/project/pull/18"
        let reverted = try JSONDecoder().decode(TaskChangeRequestOperation.self, from: JSONSerialization.data(withJSONObject: advancedJSON))
        precondition(reverted.resultURL == advancedJSON["resultURL"] as? String)
        var update = TaskChangeRequestSubmission(url: sent.url, headSha: sha, action: "update-branch", mergeMethod: nil, draft: draft)
        update.updateMethod = "rebase"
        update.expectedWorkflowSource = ["branch": "feature", "owner": "contributor"]
        precondition(update.body["expectedWorkflowSource"] as? [String: String] == update.expectedWorkflowSource)
        precondition(update.body["updateMethod"] as? String == "rebase" && update.body["mergeMethod"] == nil)
        for action in ["update-branch", "enable-auto-merge", "disable-auto-merge", "revert", "delete-branch", "approve-workflows"] {
            precondition(TaskChangeRequestConfirmation.label(action) != "关闭 PR／MR")
        }
        precondition(TaskChangeRequestConfirmation(action: "delete-branch").message.contains("新提交"))
        precondition(TaskChangeRequestConfirmation(action: "enable-auto-merge").message.contains("立即合并"))

        var replyDraft = TaskChangeRequestDraft()
        replyDraft.editors["reply:thread"] = TaskChangeRequestEditorDraft(body: "  Sent reply\n")
        let reply = TaskChangeRequestSubmission(url: sent.url, headSha: sha, action: "reply", mergeMethod: nil, draft: replyDraft, collaboration: TaskChangeRequestCollaboration(body: "  Sent reply\n", threadID: "thread"), editorKey: "reply:thread")
        precondition(reply.body["threadId"] as? String == "thread" && reply.body["body"] as? String == "  Sent reply\n")
        replyDraft.editors["reply:thread"]?.body = "Typed after sending"
        replyDraft.reconcile(reply); precondition(replyDraft.editors["reply:thread"]?.body == "Typed after sending")
        var unchangedReply = reply.draft; unchangedReply.reconcile(reply); precondition(unchangedReply.editors["reply:thread"] == nil)
        let label = TaskChangeRequestSubmission(url: sent.url, headSha: sha, action: "labels", mergeMethod: nil, draft: replyDraft, collaboration: TaskChangeRequestCollaboration(labels: ["new/label"], applied: false))
        precondition(label.body["applied"] as? Bool == false && label.body["body"] == nil)
        var activity = try JSONDecoder().decode(TaskChangeRequestActivityResponse.self, from: Data(#"{"items":[],"truncated":false,"threads":[{"id":"thread","path":"old.ts","line":3,"side":"left","isResolved":true,"isOutdated":true,"comments":[{"id":"first","author":"reviewer","body":"First","createdAt":"2026-10-19","commentKind":"review-comment","canEdit":true}],"commentCount":3,"nextCursor":"cursor-1"}]}"#.utf8))
        let nextPage = try JSONDecoder().decode(TaskChangeRequestThreadComments.self, from: Data(#"{"comments":[{"id":"first","author":"reviewer","body":"First again","createdAt":"2026-10-19","commentKind":"review-comment"},{"id":"second","author":"other","body":"Reply","createdAt":"2026-10-19","commentKind":"review-comment","canEdit":false},{"id":"second","author":"other","body":"Duplicate","createdAt":"2026-10-19","commentKind":"review-comment"}],"nextCursor":null}"#.utf8))
        precondition(!activity.appendThreadPage(nextPage, threadID: "foreign", cursor: "cursor-1"))
        precondition(!activity.appendThreadPage(nextPage, threadID: "thread", cursor: "stale-cursor"))
        precondition(activity.appendThreadPage(nextPage, threadID: "thread", cursor: "cursor-1"))
        precondition(activity.threads?[0].comments.map(\.id) == ["first", "second"] && activity.threads?[0].nextCursor == nil)
        precondition(!activity.appendThreadPage(nextPage, threadID: "thread", cursor: "cursor-1"))
        var editing = TaskChangeRequestEditorDraft(title: "Title", body: "Original", originalTitle: "Title", originalBody: "Original")
        precondition(editing.changeRequestFields.networkValue.isEmpty)
        editing.body = ""; precondition(editing.changeRequestFields.title == nil && editing.changeRequestFields.body == "")
        var description = TaskChangeRequestDraft(); description.editors["request"] = editing
        let saved = TaskChangeRequestSubmission(url: sent.url, headSha: sha, action: "edit_request", mergeMethod: nil, draft: description, collaboration: editing.changeRequestFields, editorKey: "request")
        description.editors["request"]?.body = "New paragraph typed during save"
        description.reconcile(saved)
        precondition(description.editors["request"]?.originalBody == "" && description.editors["request"]?.body == "New paragraph typed during save")
        precondition(description.editors["request"]?.changeRequestFields.title == nil)
        let remoteFile = TaskChangeRequestFiles.File(path: "new.ts", oldPath: "old.ts", status: "renamed", additions: 1, deletions: 1, patch: "@@ -7,2 +12,2 @@\n same\n-old\n+new\n", unavailable: false)
        func thread(_ id: String, _ path: String, _ line: Int, _ side: String, outdated: Bool = false) throws -> TaskChangeRequestActivityResponse.Thread {
            let value: [String: Any] = ["id": id, "path": path, "line": line, "side": side, "isResolved": false, "isOutdated": outdated, "comments": [], "commentCount": 0]
            return try JSONDecoder().decode(TaskChangeRequestActivityResponse.Thread.self, from: JSONSerialization.data(withJSONObject: value))
        }
        let threads = try [thread("left", "old.ts", 7, "left"), thread("right", "new.ts", 12, "right"), thread("deleted", "new.ts", 8, "left"), thread("added", "new.ts", 13, "right"), thread("wrong-side", "new.ts", 8, "right"), thread("outdated", "new.ts", 12, "right", outdated: true), thread("missing", "new.ts", 99, "right"), thread("foreign", "foreign.ts", 12, "right"), thread("invalid-side", "new.ts", 12, "invalid")]
        let placed = TaskRemoteThreadPlacement.annotations(threads, file: remoteFile, busy: false)
        precondition(Set(placed.compactMap(\.presentationID)) == Set(["left", "right", "deleted", "added"]))
        precondition(placed[0].selection.side == "deletions" && placed[1].selection.side == "additions")
        precondition(TaskDiffRenderedDocument(patch: remoteFile.patch, side: "additions").anchor(placed[0].selection.last) == nil)
        let changedPresentation = TaskRemoteThreadPlacement.annotations(threads, file: remoteFile, busy: true)
        precondition(changedPresentation.map(\.id) == placed.map(\.id) && changedPresentation[0].presentationVersion != placed[0].presentationVersion)
        var viewed = TaskFilesViewedOverlay()
        viewed.press("a.ts", viewed: true); let firstPress = viewed.takeBatch()!
        viewed.press("a.ts", viewed: false); viewed.acknowledge(firstPress, states: ["a.ts": "unviewed"])
        viewed.fail(firstPress); precondition(!viewed.isViewed("a.ts", states: ["a.ts": "viewed"]))
        let secondPress = viewed.takeBatch()!, beforeAcknowledgment = viewed.readOwnership
        viewed.acknowledge(secondPress, states: ["a.ts": "viewed"])
        viewed.settle(["a.ts": "unviewed"], ownership: beforeAcknowledgment); precondition(viewed.overlay["a.ts"] == false)
        let afterAcknowledgment = viewed.readOwnership
        viewed.settle(["a.ts": "viewed"], ownership: afterAcknowledgment); precondition(viewed.overlay["a.ts"] == false, "A lagging read cannot flash the checkbox back")
        viewed.settle(["a.ts": "unviewed"], ownership: afterAcknowledgment); precondition(viewed.overlay.isEmpty)
        precondition(viewed.isStale("a.ts", states: ["a.ts": "dismissed"]))
        for index in 0..<501 { viewed.press("path-\(index)", viewed: true) }
        precondition(viewed.takeBatch()?.files.count == 500 && viewed.hasQueued && viewed.takeBatch()?.files.count == 1)
        let reactionInput = TaskChangeRequestSubmission(url: sent.url, headSha: sha, action: "reaction", mergeMethod: nil, draft: TaskChangeRequestDraft(), collaboration: TaskChangeRequestCollaboration(content: "heart", reacted: true))
        let reacted = TaskReviewReactionPresentation.overlay([], input: reactionInput, subjectID: nil)
        precondition(reacted.count == 1 && reacted[0].count == 1 && reacted[0].viewerHasReacted)
        precondition(TaskReviewReactionPresentation.overlay(reacted, input: reactionInput, subjectID: nil)[0].count == 1)
        precondition(TaskReviewReactionPresentation.overlay([], input: reactionInput, subjectID: "other").isEmpty)
        let marks = TaskChangeRequestSubmission(url: sent.url, headSha: sha, action: "files_viewed", mergeMethod: nil, draft: TaskChangeRequestDraft(), collaboration: TaskChangeRequestCollaboration(files: [.init(path: " leading \tname ", viewed: false)]))
        let mark = (marks.body["files"] as! [[String: Any]])[0]
        precondition(mark["path"] as? String == " leading \tname " && mark["viewed"] as? Bool == false)
        let timelineDetailJSON: [String: Any] = [
            "pullRequest": ["number": 17, "url": "https://github.com/fixture/project/pull/17", "title": "Fixture", "state": "merged", "base": "main", "head": "feature"],
            "body": "", "author": "author", "createdAt": "2026-10-20T00:00:00+02:00", "updatedAt": "", "isDraft": false, "headSha": sha,
            "mergedAt": "2026-10-20T01:00:00Z", "closedAt": "2026-10-20T01:00:00Z", "mergeability": "clean", "actions": [], "mergeMethods": [], "verdicts": [], "canComment": true, "reviewers": [], "labels": [], "checks": []
        ]
        let timelineDetail = try JSONDecoder().decode(TaskChangeRequestDetail.self, from: JSONSerialization.data(withJSONObject: timelineDetailJSON))
        let reviewJSON: [String: Any] = ["id": "verdict", "kind": "review", "author": "reviewer", "body": "Looks good", "createdAt": "2026-10-19T23:00:00Z", "state": " APPROVED "]
        let firstCommitJSON: [String: Any] = ["oid": sha, "messageHeadline": "Earlier despite later ISO date", "committedDate": "2026-10-20T00:30:00+02:00", "authors": []]
        var timelineJSON: [String: Any] = ["items": [reviewJSON, ["id": "comment-a", "kind": "comment", "author": "first", "body": "A", "createdAt": "2026-10-19T23:10:00Z"], ["id": "comment-b", "kind": "review", "author": "second", "body": "B", "createdAt": "2026-10-19T23:11:00Z", "state": "COMMENTED"]], "truncated": false, "commits": [firstCommitJSON]]
        let firstActivity = try JSONDecoder().decode(TaskChangeRequestActivityResponse.self, from: JSONSerialization.data(withJSONObject: timelineJSON))
        let verdict = firstActivity.items[0]
        precondition(!TaskChangeRequestTimeline.isStale(verdict, commits: firstActivity.commits ?? []))
        timelineJSON["commits"] = [firstCommitJSON, ["oid": String(repeating: "c", count: 40), "messageHeadline": "Later commit", "committedDate": "2026-10-19T23:30:00Z", "authors": []]]
        let fullActivity = try JSONDecoder().decode(TaskChangeRequestActivityResponse.self, from: JSONSerialization.data(withJSONObject: timelineJSON))
        precondition(TaskChangeRequestTimeline.isStale(verdict, commits: fullActivity.commits ?? []))
        let chronological = TaskChangeRequestTimeline.entries(detail: timelineDetail, activity: fullActivity, newestFirst: false)
        precondition(chronological.first?.kind == "opened" && chronological.last?.kind == "merged")
        precondition(!chronological.contains { $0.kind == "closed" })
        precondition(chronological.firstIndex { $0.commit?.oid == sha }! < chronological.firstIndex { $0.id == "item:verdict" }!)
        let newest = TaskChangeRequestTimeline.entries(detail: timelineDetail, activity: fullActivity, newestFirst: true)
        precondition(newest.map(\.id) == chronological.reversed().map(\.id))
        let groups = TaskChangeRequestTimeline.rows(chronological).filter(\.isConversation)
        precondition(groups.count == 1 && groups[0].commentCount == 2 && groups[0].authorCount == 2)
        precondition(TaskChangeRequestTimeline.outcome("CHANGES_REQUESTED") == "changes-requested")
        precondition(TaskChangeRequestTimeline.outcome("dismissed") == "dismissed")
        precondition(TaskChangeRequestTimeline.visibleBody("  <!-- bookkeeping --> \n") == nil)
        precondition(TaskChangeRequestTimeline.visibleBody("```html\n<!-- example -->\n```") == "```html\n<!-- example -->\n```")
        let commitResponse = try JSONDecoder().decode(TaskChangeRequestCommitResponse.self, from: JSONSerialization.data(withJSONObject: ["commit": firstCommitJSON, "headSha": sha, "files": [["path": "space name.ts", "status": "modified", "additions": 1, "deletions": 1, "patch": "@@ -1 +1 @@\n-a\n+b", "unavailable": false]], "truncated": false]))
        precondition(commitResponse.commit.oid == sha && commitResponse.files[0].path == "space name.ts")
        do {
            let sameTime = TaskChangeRequestCommit(oid: String(repeating: "b", count: 40), messageHeadline: "same instant", committedDate: commitResponse.commit.committedDate, additions: nil, deletions: nil, authors: [])
            precondition(TaskChangeRequestCodeScope.ordered([sameTime, commitResponse.commit]).first?.oid == sameTime.oid)
            var scope = TaskChangeRequestCodeScope(commit: sha)
            precondition(!scope.permitsInlineComments(head: sha, loadedHead: sha, loadedScope: sha), "Commit coordinates must never be submitted as whole-change positions")
            precondition(!scope.reconcile([commitResponse.commit]))
            precondition(scope.reconcile([]) && scope.commit == nil, "A force-pushed commit must return to All commits")
            precondition(scope.permitsInlineComments(head: sha, loadedHead: sha, loadedScope: nil))
            precondition(!scope.permitsInlineComments(head: sha, loadedHead: "stale", loadedScope: nil))
            precondition(!scope.permitsInlineComments(head: sha, loadedHead: sha, loadedScope: nil, base: "base", loadedBase: "moved"))
            var pinnedReview = sent; pinnedReview.expectedBaseSha = sha
            precondition(pinnedReview.body["expectedBaseSha"] as? String == sha)
            let oldFiles = try JSONDecoder().decode(TaskChangeRequestFiles.self, from: Data(#"{"headSha":"a","files":[],"truncated":false}"#.utf8))
            func page(cursor: String?, next: String?, base: String = "base", head: String = "head", scope: String? = nil, file: String = "a", omitted: Bool = false) throws -> TaskChangeRequestFiles {
                let value: [String: Any] = ["headSha": scope ?? head, "requestHeadSha": head, "baseSha": base, "scopeCommit": scope as Any? ?? NSNull(), "cursor": cursor as Any? ?? NSNull(), "nextCursor": next as Any? ?? NSNull(), "truncated": omitted,
                    "files": [["path": file, "status": "modified", "patch": "@@ -1 +1 @@\n-old\n+new", "additions": 1, "deletions": 1, "unavailable": false, "diffCursor": cursor ?? "1"]], "omittedFileStats": omitted ? [["path": file, "additions": 17, "deletions": 4]] : []]
                return try JSONDecoder().decode(TaskChangeRequestFiles.self, from: JSONSerialization.data(withJSONObject: value))
            }
            var pages = try page(cursor: nil, next: "2")
            let second = try page(cursor: "2", next: "3", file: "later", omitted: true)
            precondition(pages.appendPage(second, requestedCursor: "2", requestHead: "head"))
            precondition(pages.files.map(\.path) == ["a", "later"] && pages.nextCursor == "3" && pages.truncated && pages.omittedFileStats?.first?.additions == 17)
            let captured = pages
            let wrongBase = try page(cursor: "3", next: nil, base: "moved")
            precondition(!pages.appendPage(wrongBase, requestedCursor: "3", requestHead: "head") && pages == captured)
            let wrongCommit = try page(cursor: "3", next: nil, scope: "commit")
            precondition(!pages.appendPage(wrongCommit, requestedCursor: "3", requestHead: "head") && pages == captured)
            let wrongHead = try page(cursor: "3", next: nil, head: "moved")
            precondition(!pages.appendPage(wrongHead, requestedCursor: "3", requestHead: "head") && pages == captured)
            let loop = try page(cursor: "3", next: "3")
            precondition(!pages.appendPage(loop, requestedCursor: "3", requestHead: "head"))
            for cursor in ["1", "0", "03", "foreign", "10000000"] {
                let invalid = try page(cursor: "3", next: cursor)
                precondition(!pages.appendPage(invalid, requestedCursor: "3", requestHead: "head") && pages == captured)
            }
            let final = try page(cursor: "3", next: nil, file: "later")
            precondition(pages.appendPage(final, requestedCursor: "3", requestHead: "head") && pages.files.count == 2 && pages.nextCursor == nil)
            precondition(oldFiles.scopeCommit == nil && oldFiles.baseSha == nil)
            var azure = try page(cursor: nil, next: "3:300")
            let azureNext = try page(cursor: "3:300", next: "3:600", file: "azure-later")
            precondition(azure.appendPage(azureNext, requestedCursor: "3:300", requestHead: "head"))
            let azureCaptured = azure
            let azureMoved = try page(cursor: "3:600", next: "4:900"), azureLoop = try page(cursor: "3:600", next: "3:300")
            precondition(!azure.appendPage(azureMoved, requestedCursor: "3:600", requestHead: "head") && azure == azureCaptured)
            precondition(!azure.appendPage(azureLoop, requestedCursor: "3:600", requestHead: "head"))
            func cafeCursor(_ after: String, version: Int = 3, head: String = "head") throws -> String {
                String(decoding: try JSONSerialization.data(withJSONObject: ["version": version, "headOid": head, "baseOid": "base", "after": after], options: [.sortedKeys]), as: UTF8.self)
            }
            let cafeFirst = try cafeCursor("first"), cafeSecond = try cafeCursor("second")
            var cafe = try page(cursor: nil, next: cafeFirst)
            let cafeNext = try page(cursor: cafeFirst, next: cafeSecond, file: "cafe-later")
            precondition(cafe.appendPage(cafeNext, requestedCursor: cafeFirst, requestHead: "head"))
            let cafeCaptured = cafe
            let cafeLoop = try page(cursor: cafeSecond, next: cafeFirst), cafeVersion = try page(cursor: cafeSecond, next: cafeCursor("third", version: 4)), cafeHead = try page(cursor: cafeSecond, next: cafeCursor("third", head: "moved")), cafeFinal = try page(cursor: cafeSecond, next: nil)
            precondition(!cafe.appendPage(cafeLoop, requestedCursor: cafeSecond, requestHead: "head") && cafe == cafeCaptured)
            precondition(!cafe.appendPage(cafeVersion, requestedCursor: cafeSecond, requestHead: "head"))
            precondition(!cafe.appendPage(cafeHead, requestedCursor: cafeSecond, requestHead: "head"))
            precondition(cafe.appendPage(cafeFinal, requestedCursor: cafeSecond, requestHead: "head"))
            let value = try JSONDecoder().decode(TaskChangeRequestFileContents.self, from: JSONSerialization.data(withJSONObject: ["path":"file.png", "side":"old", "revision":sha, "requestHeadSha":sha, "scopeCommit":sha, "kind":"image", "mimeType":"image/png", "byteLength":2, "base64":"AP8="]))
            precondition(Data(base64Encoded: value.base64!) == Data([0,255]) && value.scopeCommit == sha)
        }
        let guideJSON = #"{"guide":{"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generatedAt":"2026-10-20T00:00:00Z","modelSelection":{"agent":"codex","model":"fixture","reasoningEffort":"low"},"stops":[{"title":"Contract","summary":"Design first","attention":{"kind":"contract","note":"Public surface"},"excerpts":[{"path":"new.ts","side":"old","start":7,"end":7,"caption":"Before"}],"files":[],"notes":[],"questions":["Why this contract?"]}]},"excerpts":[{"path":"new.ts","oldPath":"old.ts","side":"old","start":7,"end":7,"caption":"Before","lines":[{"number":7,"text":"old code","position":{"kind":"deleted","oldLine":7}}]}],"run":null,"currentHeadSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","enabled":true}"#
        let guideResponse = try JSONDecoder().decode(TaskReviewGuideResponse.self, from: Data(guideJSON.utf8))
        precondition(guideResponse.stale && guideResponse.excerpts[0].oldPath == "old.ts")
        precondition(guideResponse.excerpts[0].lines[0].position?.usesOldSide == true && guideResponse.excerpts[0].lines[0].position?.selectedLine == 7)
        precondition(TaskChangeRequestPosition(kind: "context", newLine: 8, oldLine: 7, side: "left").selectedLine == 7)
        var tour = TaskGuideProgress(); tour.move(to: 1, count: 3); precondition(tour.position == 1 && tour.seen == [0]); tour.move(to: 0, count: 3); precondition(tour.seen == [0]); tour.move(to: 100, count: 3); precondition(tour.position == 2)
        tour.move(to: 0, count: 0); precondition(tour.position == 0 && tour.seen.isEmpty)
        precondition(TaskGuideProgress.key(server: "http://a", serviceID: "one", url: "pr", head: "a") != TaskGuideProgress.key(server: "http://a", serviceID: "two", url: "pr", head: "a"))
        let oldBlock = "Old question\n[guide](friday-context://v1/review-guide/fixture)"
        let newBlock = "New question\n[guide](friday-context://v1/review-guide/fixture)"
        precondition(TaskGuideComposerHandoff.merge(current: "My draft\n\n" + oldBlock + "\nUser addition", previousBlock: oldBlock, newBlock: newBlock) == "My draft\n\n" + newBlock + "\nUser addition")
        precondition(TaskGuideComposerHandoff.merge(current: "Keep my draft", previousBlock: nil, newBlock: newBlock).hasPrefix("Keep my draft\n\n"))
        precondition(TaskGuideComposerHandoff.merge(current: newBlock, previousBlock: nil, newBlock: newBlock) == newBlock)
        var heldGuide = guideResponse
        heldGuide.run = TaskReviewGuideRun(id: "guard", durableId: 2, url: "pr", headSha: sha, status: "completed", createdAt: "2026-10-20", updatedAt: "2026-10-20T01:00:00Z", modelSelection: guideResponse.guide!.modelSelection, error: nil)
        var lateGuide = guideResponse
        lateGuide.run = TaskReviewGuideRun(id: "guard", durableId: 2, url: "pr", headSha: sha, status: "running", createdAt: "2026-10-20", updatedAt: "2026-10-20T02:00:00Z", modelSelection: guideResponse.guide!.modelSelection, error: nil)
        precondition(!heldGuide.accepts(lateGuide))
        lateGuide.run = TaskReviewGuideRun(id: "older", durableId: 1, url: "pr", headSha: sha, status: "completed", createdAt: "2026-10-20", updatedAt: "2026-10-20T02:00:00Z", modelSelection: guideResponse.guide!.modelSelection, error: nil)
        precondition(!heldGuide.accepts(lateGuide))
        var notices = TaskGuideNoticeTracker()
        let guideWorkJSON: [String: Any] = ["id":"guide-task", "title":"Guide task", "prompt":"Fixture", "agent":"codex", "mode":"code", "projectId":NSNull(), "cwd":"/fixture", "status":"completed", "result":"", "createdAt":"2026-10-20", "updatedAt":"2026-10-20", "threadId":NSNull(), "turnId":NSNull(), "events":[], "approvals":[], "messages":[]]
        var guideWork = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: guideWorkJSON))
        func noticeRun(_ id: String, _ status: String, _ durable: Int = 7) -> TaskReviewGuideRun { TaskReviewGuideRun(id: id, durableId: durable, url: "https://github.com/fixture/project/pull/17", headSha: sha, status: status, createdAt: "2026-10-20", updatedAt: "2026-10-20", modelSelection: guideResponse.guide!.modelSelection, error: nil) }
        guideWork.changeRequestGuideRuns = [noticeRun("notice", "completed")]
        precondition(notices.observe(tasks: [guideWork], scope: "service-one").isEmpty)
        guideWork.changeRequestGuideRuns = [noticeRun("live", "running", 8)]
        precondition(notices.observe(tasks: [guideWork], scope: "service-one").isEmpty)
        guideWork.changeRequestGuideRuns = [noticeRun("live", "completed", 8)]
        precondition(notices.observe(tasks: [guideWork], scope: "service-one").first?.taskID == "guide-task")
        precondition(notices.observe(tasks: [guideWork], scope: "service-one").isEmpty)
        precondition(notices.observe(tasks: [guideWork], scope: "service-two").isEmpty)
        guideWork.changeRequestGuideRuns = [noticeRun("old", "running", 9)]
        _ = notices.observe(tasks: [guideWork], scope: "service-two")
        guideWork.changeRequestGuideRuns = [noticeRun("old", "interrupted", 9), noticeRun("new", "queued", 10)]
        precondition(notices.observe(tasks: [guideWork], scope: "service-two").isEmpty)
        let stackJSON: [String: Any] = ["id":"stack", "number":50, "url":"https://github.com/fixture/project/stacks/50", "base":"main", "layers":[
            ["number":16,"headBranch":"lower","state":"merged"],
            ["number":17,"headBranch":"middle","state":"open","headSha":sha],
            ["number":18,"headBranch":"upper","state":"open","headSha":String(repeating:"b",count:40)]
        ]]
        let nativeStack = try JSONDecoder().decode(TaskChangeRequestStack.self, from: JSONSerialization.data(withJSONObject: stackJSON))
        let middlePlan = nativeStack.plan(action:"merge",current:17,method:"squash")!
        precondition(middlePlan.targetNumber == 17 && middlePlan.heads.map(\.number) == [17])
        let cascadePlan = nativeStack.plan(action:"update-branch",current:17,method:"rebase")!
        precondition(cascadePlan.targetNumber == 18 && cascadePlan.heads.map(\.number) == [17,18])
        var stackSubmission = TaskChangeRequestSubmission(url:"pr",headSha:sha,action:"merge",mergeMethod:"squash",draft:TaskChangeRequestDraft())
        stackSubmission.stackNumber = 50; stackSubmission.targetNumber = middlePlan.targetNumber; stackSubmission.expectedStackHeads = middlePlan.heads
        precondition(stackSubmission.body["stackNumber"] as? Int == 50 && (stackSubmission.body["expectedStackHeads"] as? [[String:Any]])?.count == 1)
        var savedStackJSON = stackJSON; savedStackJSON["layers"] = [["number":17,"headBranch":"middle","state":"open"]]
        let headless = try JSONDecoder().decode(TaskChangeRequestStack.self,from:JSONSerialization.data(withJSONObject:savedStackJSON))
        precondition(headless.plan(action:"merge",current:17,method:"merge") == nil)

        let snapshotJSON: [String: Any] = ["state":"merged", "title":"Merged change", "headBranch":"feature", "baseBranch":"main", "isDraft":false,
            "updatedAt":"2026-10-20T00:00:00Z", "syncedAt":"2026-10-20T00:01:00Z", "closedAt":NSNull(), "mergedAt":"2026-10-20T00:00:00Z", "headSha":sha,
            "author":["login":"author", "avatarURL":"https://example.test/avatar"], "checksState":"passing"]
        let snapshot = try JSONDecoder().decode(TaskPullRequestSnapshot.self, from: JSONSerialization.data(withJSONObject:snapshotJSON))
        let snapshotCopy = try JSONDecoder().decode(TaskPullRequestSnapshot.self, from: JSONEncoder().encode(snapshot))
        precondition(snapshot == snapshotCopy && snapshot.mergedAt != nil && snapshot.headSha == sha)
        let checksJSON: [String: Any] = ["state":"open", "headSha":sha, "checks":[["name":"Build", "state":"success"]], "workflowApprovalsRequired":2, "checksState":"passing"]
        let checks = try JSONDecoder().decode(TaskChangeRequestChecks.self, from: JSONSerialization.data(withJSONObject:checksJSON))
        var refreshed = detail; refreshed.checks = checks.checks; refreshed.workflowApprovalsRequired = checks.workflowApprovalsRequired
        precondition(refreshed.checks.first?.name == "Build" && refreshed.workflowApprovalsRequired == 2 && draft.comments == [later])
        let rate = try JSONDecoder().decode(APIError.self, from: Data(#"{"error":"Quota pause","reason":"rate-limited","retryAt":1792454400000}"#.utf8))
        precondition(rate.reason == "rate-limited" && rate.retryAt == 1792454400000)

        func linked(_ number: Int, head: String, base: String, state: String = "open", source: String = "manual") throws -> TaskPullRequest {
            var snapshot = snapshotJSON; snapshot["state"] = state; snapshot["headBranch"] = head; snapshot["baseBranch"] = base; snapshot["isDraft"] = false
            return try JSONDecoder().decode(TaskPullRequest.self, from: JSONSerialization.data(withJSONObject:["number":number,"url":"https://github.com/owner/repo/pull/\(number)","title":"PR \(number)","state":state,"head":head,"base":base,"provider":"github","host":"github.com","repository":"owner/repo","linkedAt":"2026-10-20T00:00:00Z","snapshot":snapshot,"linkSource":source]))
        }
        let lower = try linked(17, head:"lower", base:"main", state:"merged"), upper = try linked(18, head:"upper", base:"lower"), sibling = try linked(19, head:"sibling", base:"lower")
        let derived = TaskPullRequestPresentation.lines([lower,upper,sibling]); precondition(derived.map(\.depth) == [0,1,1])
        let displayed = TaskPullRequestPresentation.badge([lower,upper,sibling])!; precondition(displayed.current.number == 19 && displayed.stacked && displayed.count == 3 && displayed.state == "open")
        let hidden = try linked(20, head:"hidden", base:"upper", source:"stack-dismissed")
        precondition(TaskPullRequestPresentation.lines([lower,upper,hidden]).count == 2)
        var cyclicA = try linked(21,head:"cycle-a",base:"cycle-b"), cyclicB = try linked(22,head:"cycle-b",base:"cycle-a")
        precondition(TaskPullRequestPresentation.lines([cyclicA,cyclicB]).count == 2)
        cyclicA.dismissedAt = "2026-10-20"; precondition(TaskPullRequestPresentation.lines([cyclicA,cyclicB]).count == 1)
        let oldAzure = try JSONDecoder().decode(TaskPullRequest.self,from:Data(#"{"number":17,"url":"https://org.visualstudio.com/DefaultCollection/Project/_git/Repo/pullrequest/17","provider":"azure-devops","host":"org.visualstudio.com","repository":"DefaultCollection/Project/_git/Repo","title":"Azure","state":"open","head":"head","base":"main"}"#.utf8))
        let newAzure = try JSONDecoder().decode(TaskPullRequest.self,from:Data(#"{"number":17,"url":"https://dev.azure.com/Org/Project/_git/Repo/pullrequest/17","provider":"azure-devops","host":"dev.azure.com","repository":"Org/Project/_git/Repo","title":"Azure","state":"open","head":"head","base":"main"}"#.utf8))
        precondition(TaskPullRequestPresentation.identity(oldAzure) == TaskPullRequestPresentation.identity(newAzure))
        let sourceFlags = try JSONDecoder().decode(TaskSettlementScope.self,from:Data(#"{"sidebarAutoSettleAfterDays":null,"sidebarAutoSettleOnMerge":false,"sidebarAutoSettleKeepPullRequests":true}"#.utf8))
        precondition(sourceFlags.hasDaysOverride && sourceFlags.sidebarAutoSettleOnMerge == false && sourceFlags.sidebarAutoSettleKeepPullRequests == true)
        let submission = TaskChangeRequestLinkSubmission(reference:"#17",revision:3,linked:false)
        precondition(submission.body["expectedRevision"] as? Int == 3 && submission.body["requestId"] as? String == submission.requestID)
        let watching = TaskChangeRequestLinkSubmission(reference:"#17",revision:3,linked:true,watching:false)
        precondition(watching.action == "watch" && watching.body["watching"] as? Bool == false && watching.body["requestId"] as? String == watching.requestID)
        let watch = try JSONDecoder().decode(TaskPullRequestWatch.self,from:Data(#"{"startedAt":"2026-10-20T12:00:00Z","headSha":null,"failedChecks":[],"passed":false,"remarksThrough":"2026-10-20T12:00:00Z","remarkIds":[],"conflicting":false,"wakes":0}"#.utf8))
        precondition(watch.passedChecks == nil && watch.wakes == 0)
        var monitored = oldAzure; monitored.watch = watch
        let monitoredCopy = try JSONDecoder().decode(TaskPullRequest.self,from:JSONEncoder().encode(monitored))
        precondition(monitoredCopy.watch == watch)
        print("Task change request DTO and concurrent draft reconciliation checks passed")
    }
}
