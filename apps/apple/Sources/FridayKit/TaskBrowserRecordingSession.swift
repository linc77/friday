import SwiftUI
import WebKit

@MainActor private final class TaskBrowserRecordingHandler:NSObject,WKScriptMessageHandler {
    weak var owner:TaskBrowserRecordingSession?
    init(_ owner:TaskBrowserRecordingSession) {self.owner=owner}
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage) {owner?.receive(message)}
}
@MainActor final class TaskBrowserRecordingSession:NSObject,ObservableObject {
    @Published private(set) var phase:TaskBrowserRecordingPhase = .starting
    private weak var controller:(any TaskBrowserCaptureOwner)?
    private let pump:TaskBrowserFrames
    private let store:TaskBrowserArtifactStore
    private let artifact:TaskBrowserArtifact
    private var lease:TaskBrowserRecordingLease?
    private let operationID=UUID()
    private var completion:Result<Void,Error>?
    private var waiters:[CheckedContinuation<Void,Error>]=[]
    private let frameRate:Int
    private let world:WKContentWorld?
    private let nonce=UUID().uuidString
    private var lifecycle=TaskBrowserRecordingLifecycle()
    private var writer:TaskBrowserMovieWriter?
    private var subscription:UUID?
    private var pending:Task<Void,Never>?
    private var preparing:Task<Void,Never>?
    private var busy=false
    private var failures=0
    private var handler:TaskBrowserRecordingHandler?
    private var decorations:TaskBrowserRecordingDecorations
    init(controller:any TaskBrowserCaptureOwner,frameRate:Int,artifactStore:TaskBrowserArtifactStore?=nil)throws {
        self.controller=controller;pump=controller.frames;self.frameRate=frameRate;world=(controller as? TaskBrowserController)?.recordingWorld
        store=try artifactStore ?? TaskBrowserArtifactStore(scope:controller.artifactScope);artifact=try store.prepare(page:controller.captureURL ?? "",recording:true)
        lease=try store.beginRecording(artifact)
        decorations=TaskBrowserRecordingDecorations(showKeys:UserDefaults.standard.bool(forKey:"friday.browser.recording.keys"),showMouse:UserDefaults.standard.bool(forKey:"friday.browser.recording.mouse"));super.init()
    }
    func elapsed(at date:Double=ProcessInfo.processInfo.systemUptime)->Double {lifecycle.elapsed(at:date)}
    func start() {
        guard let controller,!controller.captureClosed else{stop();return}
        TaskBrowserCaptureRegistry.shared.register(id:operationID,stop:{ [weak self] in self?.stop() },wait:{ [self] in try await waitForFinished() })
        preparing=Task { [self] in
            guard lifecycle.acceptsFrames,!controller.captureClosed else{return}
            do {
                try await controller.prepareRecording(nonce:nonce,showKeys:decorations.showKeys)
                guard lifecycle.acceptsFrames,!controller.captureClosed else{return}
                if let local=controller as? TaskBrowserController,let world {let handler=TaskBrowserRecordingHandler(self);self.handler=handler;local.view.configuration.userContentController.add(handler,contentWorld:world,name:"fridayBrowserRecording");restoreInput()}
                subscription=pump.subscribe(fps:frameRate) { [weak self] result,now in self?.frame(result,now:now) }
            }catch {stop(error:error)}
        }
    }

    func restoreInput() {
        guard lifecycle.acceptsFrames,let controller=controller as? TaskBrowserController,!controller.closed,let world,let path=Bundle.module.url(forResource:"BrowserRecordingInput",withExtension:"js"),let source=try? String(contentsOf:path,encoding:.utf8) else{return}
        decorations.clear()
        controller.view.callAsyncJavaScript(source+"\nreturn FridayBrowserRecordingInput.start(nonce,documentID,showKeys);",arguments:["nonce":nonce,"documentID":controller.documentID.uuidString,"showKeys":decorations.showKeys],in:nil,in:world,completionHandler:nil)
    }
    fileprivate func receive(_ message:WKScriptMessage) {
        guard lifecycle.acceptsFrames,let controller=controller as? TaskBrowserController,message.webView === controller.view,message.frameInfo.isMainFrame,let body=message.body as? [String:Any],body["nonce"] as? String==nonce,body["document"] as? String==controller.documentID.uuidString,let data=try? JSONSerialization.data(withJSONObject:body),data.count<8192,let input=try? JSONDecoder().decode(TaskBrowserRecordingInput.self,from:data) else{return}
        decorations.apply(input,now:ProcessInfo.processInfo.systemUptime)
    }
    func clearInput() {decorations.clear()}
    func receiveRemote(_ input:TaskBrowserRecordingInput) {
        guard lifecycle.acceptsFrames,input.nonce==nonce,let controller,!controller.captureClosed,input.document==controller.captureDocument else{return}
        decorations.apply(input,now:ProcessInfo.processInfo.systemUptime)
    }
    private func frame(_ result:Result<CGImage,Error>,now:Double) {
        guard lifecycle.acceptsFrames,!busy else{return}
        switch result {
        case .failure(let error):failures+=1;if failures>=3 {stop(error:error)}
        case .success(let image):
            failures=0
            do {
                if writer==nil {writer=try TaskBrowserMovieWriter(url:store.url(artifact),imageSize:CGSize(width:image.width,height:image.height),frameRate:frameRate,lease:lease);_=lifecycle.firstFrame(at:now);phase=lifecycle.phase}
                guard let writer else{return};busy=true;let seconds=lifecycle.elapsed(at:now),decoration=decorations
                pending=Task { [self] in
                    do {_=try await writer.append(image,seconds:seconds,decoration:decoration,now:now);busy=false}
                    catch {busy=false;stop(error:error)}
                }
            }catch {stop(error:error)}
        }
    }
    func stop(error:Error?=nil) {
        guard lifecycle.stop() else{return};phase=lifecycle.phase
        if let subscription {pump.unsubscribe(subscription)};subscription=nil
        if let controller=controller as? TaskBrowserController,let world {
            controller.view.configuration.userContentController.removeScriptMessageHandler(forName:"fridayBrowserRecording",contentWorld:world)
            controller.view.callAsyncJavaScript("return globalThis.FridayBrowserRecordingInput?.stop(nonce);",arguments:["nonce":nonce],in:nil,in:world,completionHandler:nil)
        };handler=nil
        let seconds=lifecycle.elapsed(at:ProcessInfo.processInfo.systemUptime),work=pending,begin=preparing
        Task { [self] in
            await begin?.value;await controller?.finishRecordingInput(nonce:nonce);preparing=nil
            await work?.value
            var result:Result<Void,Error> = .success(())
            do {
                if let writer {try await writer.finish(seconds:seconds);try store.commit(artifact);controller?.publish(artifact,store:store);if error != nil,controller?.captureClosed==false {controller?.message="录屏中断，已保存已有画面"}}
                else{store.remove(artifact);if let error,controller?.captureClosed==false {controller?.message=error.localizedDescription}}
            }catch {result = .failure(error);writer?.cancel();if writer==nil {store.remove(artifact)};if controller?.captureClosed==false {controller?.message=error.localizedDescription}}
            lifecycle.finish();phase=lifecycle.phase
            completion=result;let pendingWaiters=waiters;waiters=[];for waiter in pendingWaiters {waiter.resume(with:result)}
            lease=nil;writer=nil;TaskBrowserCaptureRegistry.shared.remove(operationID)
            if controller?.recordingSession === self {controller?.recordingSession=nil}
            controller?.recordingDidFinish()
        }
    }
    private func waitForFinished() async throws {
        if let completion {return try completion.get()}
        try await withCheckedThrowingContinuation {waiters.append($0)}
    }
}
