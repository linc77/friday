import Foundation
import WebKit
import CoreGraphics
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor final class TaskBrowserFrameSampler {
    typealias Capture=(@escaping(Result<CGImage,Error>)->Void)->Void
    private let capture:Capture
    private let timeout:Duration
    private var generation:UUID?
    private var waiters:[CheckedContinuation<CGImage,Error>]=[]
    init(timeout:Duration = .seconds(4),capture:@escaping Capture) {self.timeout=timeout;self.capture=capture}
    func request() async throws->CGImage {
        try await withCheckedThrowingContinuation {continuation in
            waiters.append(continuation);guard generation==nil else{return}
            let id=UUID();generation=id
            Task { @MainActor [weak self,timeout] in try? await Task.sleep(for:timeout);self?.finish(id,.failure(ConnectionError.message("网页截取超时"))) }
            capture { [weak self] result in self?.finish(id,result) }
        }
    }
    private func finish(_ id:UUID,_ result:Result<CGImage,Error>) {guard generation==id else{return};generation=nil;let callbacks=waiters;waiters=[];for callback in callbacks {callback.resume(with:result)}}
    func cancel() {if let id=generation {finish(id,.failure(CancellationError()))}}
}
@MainActor final class TaskBrowserFrames {
    private let sampler:TaskBrowserFrameSampler
    private var consumers:[UUID:(Int,(Result<CGImage,Error>,Double)->Void)]=[:]
    private var deliveries:[UUID:Double]=[:]
    private var loop:Task<Void,Never>?
    private var activity:((Bool)->Void)?
    var active:Bool {!consumers.isEmpty}
    init(view:WKWebView) {
        sampler=TaskBrowserFrameSampler { [weak view] completion in
            guard let view,view.bounds.width>0,view.bounds.height>0 else{completion(.failure(ConnectionError.message("网页尚未显示")));return}
            let config=WKSnapshotConfiguration();config.afterScreenUpdates=true
            #if os(macOS)
            let scale=view.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
            #else
            let scale=view.window?.screen.scale ?? UIScreen.main.scale
            #endif
            let pixels=TaskBrowserCapturePolicy.videoSize(CGSize(width:view.bounds.width*scale,height:view.bounds.height*scale))
            config.snapshotWidth=NSNumber(value:pixels.width/scale)
            view.takeSnapshot(with:config) {image,error in
                #if os(macOS)
                let cg=image?.cgImage(forProposedRect:nil,context:nil,hints:nil)
                #else
                let cg=image?.cgImage
                #endif
                if let cg {completion(.success(cg))} else{completion(.failure(error ?? ConnectionError.message("无法截取页面")))}
            }
        }
    }
    init(capture:@escaping TaskBrowserFrameSampler.Capture,activity:((Bool)->Void)?=nil) {sampler=TaskBrowserFrameSampler(capture:capture);self.activity=activity}
    func capture() async throws->CGImage {try await sampler.request()}
    @discardableResult func subscribe(fps:Int,receive:@escaping(Result<CGImage,Error>,Double)->Void)->UUID {
        let id=UUID();consumers[id]=(max(1,min(60,fps)),receive)
        if loop==nil {activity?(true);loop=Task { [weak self] in await self?.run() }};return id
    }
    func unsubscribe(_ id:UUID) {consumers.removeValue(forKey:id);deliveries.removeValue(forKey:id);if consumers.isEmpty {loop?.cancel();loop=nil;activity?(false)}}
    func close() {consumers=[:];deliveries=[:];loop?.cancel();loop=nil;sampler.cancel();activity?(false)}
    private func run() async {
        while !Task.isCancelled,!consumers.isEmpty {
            let before=ProcessInfo.processInfo.systemUptime
            let result:Result<CGImage,Error>
            do {result = .success(try await sampler.request())}catch{result = .failure(error)}
            guard !Task.isCancelled else{return}
            let now=ProcessInfo.processInfo.systemUptime
            for (id,(fps,receive)) in Array(consumers) where now-(deliveries[id] ?? -.infinity)>=1/Double(fps)-0.001 {deliveries[id]=now;receive(result,now)}
            let fps=consumers.values.map(\.0).max() ?? 12,delay=max(0,1/Double(fps)-(now-before))
            do {try await Task.sleep(for:.seconds(delay))}catch{return}
        }
    }
    static func png(_ image:CGImage)->Data? {
        #if os(macOS)
        NSBitmapImageRep(cgImage:image).representation(using:.png,properties:[:])
        #else
        UIImage(cgImage:image).pngData()
        #endif
    }
}
