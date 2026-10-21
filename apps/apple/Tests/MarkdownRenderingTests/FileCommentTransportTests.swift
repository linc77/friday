import XCTest
@testable import FridayKit

private final class ReviewRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [(String, [String: Any], String)] = []
    func record(_ path: String, _ body: [String: Any], method: String) { lock.lock(); defer { lock.unlock() }; values.append((path, body, method)) }
    func take() -> [(String, [String: Any], String)] { lock.lock(); defer { lock.unlock() }; let result = values; values = []; return result }
}
private final class ReviewProtocol: URLProtocol, @unchecked Sendable {
    static let requests = ReviewRequests()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "friday-file-review.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream { stream.open(); defer { stream.close() }; var bytes = [UInt8](repeating: 0, count: 4096); while stream.hasBytesAvailable { let count = stream.read(&bytes, maxLength: bytes.count); if count <= 0 { break }; data.append(contentsOf: bytes.prefix(count)) } }
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let path = request.url!.path; Self.requests.record(path, body, method: request.httpMethod ?? "GET")
        let payload: [String: Any], status: Int
        if ["/api/task-contexts","/api/task-contexts/browser-annotation"].contains(path), let id = body["id"] as? String {
            let reference: [String: Any] = ["id": id, "kind": body["kind"] ?? "review-comment", "label": "file.swift L1", "capturedAt": "2026-10-19T00:00:00Z", "digest": "captured", "byteLength": 7, "path": body["path"] ?? "file.swift", "lineStart": body["lineStart"] ?? 1, "lineEnd": body["lineEnd"] ?? 1]
            payload = reference; status = 201
        } else if request.httpMethod != "GET" { payload = ["id": "created"]; status = 200 }
        else { payload = ["error": "No state fixture"]; status = 503 }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: payload)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor final class FileCommentTransportTests: XCTestCase {
    private func reference(_ store: FridayStore, scope: TaskContextScope) -> TaskContextReference {
        let root = "/project", tokenScope = TaskFileMentionPayload.scope(server: store.connection.server, token: store.connection.token, cwd: root, serviceId: store.serviceId)
        return TaskFileReviewDraft(commentID: UUID().uuidString, scope: tokenScope, target: store.connection.server + "\n" + scope.identity + "\nqueue:", workspaceRoot: root, workspaceVersion: "fixture", path: "file.swift", range: TaskSourceLineRange(1, 1), comment: "Fix this", contents: "unsaved").reference
    }
    func testEachSubmissionPathMaterializesTheExactDraftBeforeDispatchingOnlyItsCaptureID() async throws {
        XCTAssertTrue(URLProtocol.registerClass(ReviewProtocol.self)); defer { URLProtocol.unregisterClass(ReviewProtocol.self); _ = ReviewProtocol.requests.take() }
        let store = FridayStore(); store.connection.server = "https://friday-file-review.test"; store.connection.token = "fixture"
        _ = ReviewProtocol.requests.take()
        let task = TaskContextScope(taskID: "task"), project = TaskContextScope(projectID: "project")
        for action in 0..<4 {
            let ref = reference(store, scope: action == 3 ? project : task), text = TaskContextDocument.token(ref)
            if action == 0 { try await store.sendTaskMessage(taskId: "task", text: text, requestId: "message", images: [], model: nil, effort: nil, contexts: [ref]) }
            if action == 1 { try await store.editQueuedMessage(taskId: "task", messageId: "queued", text: text, images: [], model: nil, effort: nil, contexts: [ref]) }
            if action == 2 { _ = try await store.followUpPlan("task", eventID: "plan", text: text, images: [], requestID: "refine", newThread: false, model: "model", effort: "low", contexts: [ref]) }
            if action == 3 { _ = try await store.createTask(prompt: text, requestId: "new", projectId: "project", agent: "codex", contexts: [ref]) }
            let requests = ReviewProtocol.requests.take().filter { $0.2 != "GET" }
            XCTAssertEqual(requests.count, 2); XCTAssertEqual(requests.first?.0, "/api/task-contexts")
            XCTAssertEqual(requests.first?.1["contents"] as? String, "unsaved"); XCTAssertEqual(requests.first?.1["comment"] as? String, "Fix this")
            XCTAssertEqual(requests.last?.1["contextIds"] as? [String], [ref.id]); XCTAssertNil(requests.last?.1["reviewDraft"])
        }
    }
    func testAnUnusedDraftOrOneFromAnotherAccountNeverBecomesANetworkCapture() async throws {
        XCTAssertTrue(URLProtocol.registerClass(ReviewProtocol.self)); defer { URLProtocol.unregisterClass(ReviewProtocol.self); _ = ReviewProtocol.requests.take() }
        let store = FridayStore(); store.connection.server = "https://friday-file-review.test"; store.connection.token = "first"; _ = ReviewProtocol.requests.take()
        let scope = TaskContextScope(taskID: "task"), ref = reference(store, scope: scope)
        let unused = try await store.materializeTaskContexts(text: "no reference", contexts: [ref], scope: scope); XCTAssertTrue(unused.isEmpty)
        store.connection.token = "another account"
        do { _ = try await store.materializeTaskContexts(text: TaskContextDocument.token(ref), contexts: [ref], scope: scope); XCTFail("Cross-account draft accepted") } catch {}
        XCTAssertTrue(ReviewProtocol.requests.take().isEmpty)
    }
    private func annotation(_ store:FridayStore,scope:TaskContextScope)throws->TaskContextReference {
        let root="/project",record=TaskBrowserAnnotationRecord(annotationId:"browser-note",pageUrl:"http://localhost:3000/",pageTitle:"Preview",comment:"keep original draft",elements:[],elementIds:[],styleChangeDetails:[],regionCount:1,strokeCount:0)
        return try XCTUnwrap(TaskBrowserAnnotationDraft(record:record,target:store.connection.server+"\n"+scope.identity+"\nqueue:edited",scope:TaskFileMentionPayload.scope(server:store.connection.server,token:store.connection.token,cwd:root,serviceId:store.serviceId),workspaceRoot:root).reference)
    }
    func testEveryBrowserAnnotationSubmissionUsesItsDedicatedCaptureBeforeSendingTheExistingDraft() async throws {
        XCTAssertTrue(URLProtocol.registerClass(ReviewProtocol.self));defer {URLProtocol.unregisterClass(ReviewProtocol.self);_=ReviewProtocol.requests.take()}
        let store=FridayStore();store.connection.server="https://friday-file-review.test";store.connection.token="annotation-fixture";_=ReviewProtocol.requests.take()
        for action in 0..<4 {
            let scope=action==3 ? TaskContextScope(projectID:"project"):TaskContextScope(taskID:"task"),ref=try annotation(store,scope:scope),text="existing draft "+TaskContextDocument.token(ref)
            if action==0 {try await store.sendTaskMessage(taskId:"task",text:text,requestId:"message",images:[],model:nil,effort:nil,contexts:[ref])}
            if action==1 {try await store.editQueuedMessage(taskId:"task",messageId:"queued",text:text,images:[],model:nil,effort:nil,contexts:[ref])}
            if action==2 {_=try await store.followUpPlan("task",eventID:"plan",text:text,images:[],requestID:"refine",newThread:false,model:"model",effort:"low",contexts:[ref])}
            if action==3 {_=try await store.createTask(prompt:text,requestId:"new",projectId:"project",agent:"codex",contexts:[ref])}
            let requests=ReviewProtocol.requests.take().filter {$0.2 != "GET"};XCTAssertEqual(requests.count,2);XCTAssertEqual(requests.first?.0,"/api/task-contexts/browser-annotation")
            let record=requests.first?.1["annotation"] as? [String:Any];XCTAssertEqual(record?["comment"] as? String,"keep original draft");XCTAssertEqual(requests.last?.1["contextIds"] as? [String],[ref.id]);XCTAssertNil(requests.last?.1["annotation"]);XCTAssertNil(requests.last?.1["annotationDraft"])
            XCTAssertTrue((requests.last?.1["prompt"] as? String ?? requests.last?.1["text"] as? String ?? "").hasPrefix("existing draft "))
        }
    }
    func testUnusedCrossTaskAndCrossAccountBrowserDraftsDoNotCreateNetworkCaptures() async throws {
        XCTAssertTrue(URLProtocol.registerClass(ReviewProtocol.self));defer {URLProtocol.unregisterClass(ReviewProtocol.self);_=ReviewProtocol.requests.take()}
        let store=FridayStore();store.connection.server="https://friday-file-review.test";store.connection.token="annotation-first";_=ReviewProtocol.requests.take()
        let scope=TaskContextScope(taskID:"task"),ref=try annotation(store,scope:scope)
        let local=try await store.taskContext(ref,scope:scope);XCTAssertEqual(local.browserAnnotation?.comment,"keep original draft")
        let unused=try await store.materializeTaskContexts(text:"no annotation token",contexts:[ref],scope:scope);XCTAssertTrue(unused.isEmpty)
        do {_=try await store.materializeTaskContexts(text:TaskContextDocument.token(ref),contexts:[ref],scope:TaskContextScope(taskID:"other"));XCTFail("Cross-task draft accepted")}catch{}
        store.connection.token="annotation-other"
        do {_=try await store.materializeTaskContexts(text:TaskContextDocument.token(ref),contexts:[ref],scope:scope);XCTFail("Cross-account draft accepted")}catch{}
        XCTAssertTrue(ReviewProtocol.requests.take().isEmpty)
    }
}
