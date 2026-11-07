import Foundation
import Darwin
#if os(iOS)
import UIKit
#endif

/// Actual file ownership, rather than a PID or the age of a journal, determines recovery eligibility.
final class TaskBrowserRecordingLease:@unchecked Sendable {
    private let descriptor:Int32
    init(folder:URL)throws {
        let descriptor=Darwin.open(folder.appendingPathComponent(".recording.lock").path,O_RDWR|O_CREAT|O_CLOEXEC|O_NOFOLLOW,0o600)
        guard descriptor>=0 else{throw ConnectionError.message("无法锁定录屏文件")}
        guard flock(descriptor,LOCK_EX|LOCK_NB)==0 else{Darwin.close(descriptor);throw ConnectionError.message("录屏仍在写入，请稍后再试")}
        self.descriptor=descriptor
    }
    deinit {flock(descriptor,LOCK_UN);Darwin.close(descriptor)}
}

@MainActor final class TaskBrowserCaptureRegistry {
    static let shared=TaskBrowserCaptureRegistry()
    private var operations:[UUID:()->Void]=[:]
    private var waits:[UUID:() async throws->Void]=[:]
    private(set) var terminating=false
    var active:Bool {!waits.isEmpty}
    func register(id:UUID,stop:@escaping()->Void={},wait:@escaping() async throws->Void) {operations[id]=stop;waits[id]=wait}
    func remove(_ id:UUID) {operations.removeValue(forKey:id);waits.removeValue(forKey:id)}
    func prepareToQuit() async throws {
        terminating=true
        if !waits.isEmpty {
            let batch=Array(waits.values);for stop in Array(operations.values) {stop()}
            let error=await withTaskGroup(of:Error?.self,returning:Error?.self) {group in
                for wait in batch {group.addTask { @MainActor in do {try await wait();return nil}catch{return error}}}
                var failure:Error?;for await result in group {if failure==nil {failure=result}};return failure
            }
            if let error {throw error}
        }
    }
    func cancelQuit() {terminating=false}
}

/// Used by the app delegate; normal quitting only drains client capture work.
@MainActor public enum FridayClientLifecycle {
    public static var hasPendingCaptures:Bool {TaskBrowserCaptureRegistry.shared.active}
    public static func prepareToQuit() async throws {try await TaskBrowserCaptureRegistry.shared.prepareToQuit()}
    public static func cancelQuit() {TaskBrowserCaptureRegistry.shared.cancelQuit()}
    #if os(iOS)
    public static func enteredBackground() {
        guard hasPendingCaptures else{return}
        let identifier=UIApplication.shared.beginBackgroundTask(withName:"FridayCaptureSave",expirationHandler:nil)
        Task {
            defer {if identifier != .invalid {UIApplication.shared.endBackgroundTask(identifier)};if UIApplication.shared.applicationState == .active {TaskBrowserCaptureRegistry.shared.cancelQuit()}}
            do {try await TaskBrowserCaptureRegistry.shared.prepareToQuit()}catch{}
        }
    }
    #endif
}

final class TaskBrowserCaptureReply<Value>:@unchecked Sendable {
    private let lock=NSLock()
    private var continuation:CheckedContinuation<Value,Error>?
    init(_ continuation:CheckedContinuation<Value,Error>,timeout:TimeInterval=15) {
        self.continuation=continuation
        DispatchQueue.global(qos:.utility).asyncAfter(deadline:.now()+timeout) {self.finish(.failure(ConnectionError.message("录屏保存超时，文件已保留以便恢复")))}
    }
    func finish(_ result:Result<Value,Error>) {lock.lock();let value=continuation;continuation=nil;lock.unlock();value?.resume(with:result)}
}
