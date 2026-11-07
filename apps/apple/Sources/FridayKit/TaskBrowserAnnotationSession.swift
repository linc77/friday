import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum TaskBrowserAnnotationTool:String,Codable,CaseIterable,Identifiable {
    case select,marquee,draw,erase
    var id:String {rawValue}
    var label:String {switch self {case .select:"选择元素";case .marquee:"框选区域";case .draw:"自由绘制";case .erase:"擦除标记"}}
    var symbol:String {switch self {case .select:"cursorarrow";case .marquee:"rectangle.dashed";case .draw:"pencil.tip";case .erase:"eraser"}}
    var key:String {switch self {case .select:"V";case .marquee:"R";case .draw:"D";case .erase:"E"}}
}
struct TaskBrowserAnnotationViewport:Decodable {let width:Double;let height:Double}
struct TaskBrowserAnnotationSnapshot:Decodable {
    let nonce:String;let pageUrl:String;let pageTitle:String?;let viewport:TaskBrowserAnnotationViewport
    let tool:TaskBrowserAnnotationTool;let elements:[TaskBrowserAnnotationElement];let regions:[TaskBrowserAnnotationRegion];let strokes:[TaskBrowserAnnotationStroke]
    let styleChanges:[TaskBrowserStyleChange];let styleValues:[String:String]
    var hasTargets:Bool {!elements.isEmpty || !regions.isEmpty || !strokes.isEmpty}
    var valid:Bool {
        viewport.width.isFinite && viewport.height.isFinite && viewport.width>0 && viewport.height>0 && viewport.width<=100_000 && viewport.height<=100_000
        && elements.count<=50 && regions.count<=200 && strokes.count<=200 && styleChanges.count<=200
        && elements.allSatisfy {$0.rect.valid} && regions.allSatisfy {$0.rect.valid}
        && strokes.reduce(0,{$0+$1.points.count})<=20_000 && strokes.allSatisfy {$0.bounds.valid && $0.points.count<=5000 && $0.points.allSatisfy {$0.x.isFinite && $0.y.isFinite}}
    }
    var rects:[TaskBrowserAnnotationRect] {elements.map(\.rect)+regions.map(\.rect)+strokes.map(\.bounds)}
}

/// An accepted attachment belongs to the composer; later browser teardown cannot revoke it.
struct TaskBrowserAnnotationLifetime {
    let document:UUID
    private(set) var cancelled=false
    private(set) var accepted=false
    mutating func accept(document:UUID,currentComposer:Bool)->Bool {
        guard !cancelled,!accepted,self.document==document,currentComposer else{return false};accepted=true;return true
    }
    mutating func cancel() {if !accepted {cancelled=true}}
    func current(document:UUID)->Bool {!cancelled && !accepted && self.document==document}
}

@MainActor private final class TaskBrowserAnnotationReply<Value> {
    private var continuation:CheckedContinuation<Value,Error>?
    init(_ continuation:CheckedContinuation<Value,Error>,seconds:Double) {
        self.continuation=continuation
        Task { @MainActor [weak self] in try? await Task.sleep(for:.seconds(seconds));self?.finish(.failure(ConnectionError.message("网页处理超时"))) }
    }
    func finish(_ result:Result<Value,Error>) {let value=continuation;continuation=nil;value?.resume(with:result)}
}
@MainActor private final class TaskBrowserAnnotationHandler:NSObject,WKScriptMessageHandler {
    weak var owner:TaskBrowserAnnotationSession?
    init(_ owner:TaskBrowserAnnotationSession) {self.owner=owner}
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage) {owner?.receive(message)}
}

@MainActor final class TaskBrowserAnnotationSession:NSObject,ObservableObject {
    @Published private(set) var snapshot:TaskBrowserAnnotationSnapshot?
    @Published private(set) var ready=false
    @Published private(set) var capturing=false
    @Published var comment=""
    @Published var error:String?
    @Published var expanded=false
    @Published var inspecting=false
    @Published private(set) var focusRequest=0
    let composer:TaskBrowserAnnotationComposer
    let nonce=UUID().uuidString
    private weak var controller:TaskBrowserController?
    private weak var host:TaskHostBrowserController?
    private let hostContext:TaskHostBrowserTransferContext?
    private var tornDown=false
    private let world:WKContentWorld
    private var lifetime:TaskBrowserAnnotationLifetime
    private var handler:TaskBrowserAnnotationHandler?
    private var focusedOnce=false
    private var scopeWatch:Task<Void,Never>?
    private var commands:Task<Void,Never>?
    init(controller:TaskBrowserController,composer:TaskBrowserAnnotationComposer) {
        self.controller=controller;self.composer=composer;hostContext=nil;lifetime=TaskBrowserAnnotationLifetime(document:controller.documentID)
        world=controller.annotationWorld;super.init()
    }
    init(host:TaskHostBrowserController,composer:TaskBrowserAnnotationComposer)throws {
        self.host=host;self.composer=composer;hostContext=try host.annotationContext()
        guard let document=UUID(uuidString:host.captureDocument) else{throw ConnectionError.message("网页已变化，请重新选择")}
        lifetime=TaskBrowserAnnotationLifetime(document:document);world=WKContentWorld.world(name:"friday-host-annotation");super.init()
    }
    private var documentID:UUID? {controller?.documentID ?? host.flatMap {UUID(uuidString:$0.captureDocument)}}
    var current:Bool {
        guard !tornDown,let documentID,lifetime.current(document:documentID) else{return false}
        if let host,let hostContext {return host.annotationSession === self && host.annotationIsCurrent(hostContext)}
        return controller?.annotationSession === self
    }
    private func notice(_ message:String) {if let controller {controller.message=message}else{host?.message=message}}

    func start() async {
        guard current,composer.current() else{cancel();return}
        do {
            if let controller {
                let handler=TaskBrowserAnnotationHandler(self);self.handler=handler
                controller.view.configuration.userContentController.add(handler,contentWorld:world,name:"fridayBrowserAnnotation")
            }
            let value=try await call("start")
            guard current,composer.current() else{cancel();return};if let text=value as? String {receive(text)};ready=true
            scopeWatch=Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    do {try await Task.sleep(for:.milliseconds(250))}catch{return}
                    guard let self else{return}
                    guard self.current,self.composer.current() else{self.cancel();return}
                    if self.hostContext != nil,!self.capturing {
                        do {if let text=try await self.call("read") as? String {self.receive(text)}}
                        catch {if self.current {self.notice(error.localizedDescription)};self.cancel();return}
                    }
                }
            }
        } catch {if current {notice(error.localizedDescription)};cancel()}
    }
    fileprivate func receive(_ message:WKScriptMessage) {
        guard current,message.webView === controller?.view,message.frameInfo.isMainFrame,let body=message.body as? [String:Any],body["nonce"] as? String==nonce else{return}
        guard let data=try? JSONSerialization.data(withJSONObject:body),let text=String(data:data,encoding:.utf8) else{return};receive(text)
    }
    private func receive(_ text:String) {
        guard current,text.utf8.count<=4*1024*1024,let data=text.data(using:.utf8),let body=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],body["nonce"] as? String==nonce else{return}
        if body["kind"] as? String=="cancel" {cancel();return}
        guard !capturing,let value=try? JSONDecoder().decode(TaskBrowserAnnotationSnapshot.self,from:data),value.valid else{return}
        snapshot=value
        if value.hasTargets && !focusedOnce {focusedOnce=true;focusRequest+=1}
    }
    func choose(_ tool:TaskBrowserAnnotationTool) {enqueue("tool",arguments:["tool":tool.rawValue])}
    func style(_ property:String,_ value:String) {enqueue("style",arguments:["property":property,"value":value])}
    private func enqueue(_ action:String,arguments:[String:Any]) {
        guard !capturing,current else{return};let previous=commands
        commands=Task { @MainActor [weak self] in
            await previous?.value;guard let self,self.current else{return}
            do {let result=try await self.call(action,arguments:arguments);if let text=result as? String {self.receive(text)}else if result as? Bool != true {self.error="无法应用样式"}}
            catch {if self.current {self.error=error.localizedDescription}}
        }
    }
    func submit(send:Bool) {
        guard current,composer.current(),ready,!capturing,comment.utf16.count<=8000,snapshot?.hasTargets==true else{return}
        capturing=true;error=nil;let comment=TaskBrowserAnnotationText.trim(comment)
        Task {
            do {
                await commands?.value;guard current,composer.current() else{cancel();return}
                let raw=try await call("freeze",arguments:["value":true])
                guard let text=raw as? String,let value=try? JSONDecoder().decode(TaskBrowserAnnotationSnapshot.self,from:Data(text.utf8)),value.nonce==nonce,value.valid,value.hasTargets else{throw ConnectionError.message("所选元素已不可用，请重新选择")}
                let detailed=await captureElements(value)
                guard current,composer.current() else{cancel();return}
                let screenshot=await captureImage(value)
                guard current,let documentID else{return}
                let selected=Dictionary(uniqueKeysWithValues:zip(value.elements.map(\.id),detailed.map(\.selector)))
                let changes=value.styleChanges.map {c in var c=c;if let selector=selected[c.targetId] {c.selector=selector};return c}
                let record=TaskBrowserAnnotationRecord(annotationId:nonce,pageUrl:value.pageUrl,pageTitle:value.pageTitle,comment:comment,elements:detailed,elementIds:value.elements.map(\.id),styleChangeDetails:changes,regionCount:value.regions.count,strokeCount:value.strokes.count).normalized
                guard record.valid else{throw ConnectionError.message("网页批注过大或格式无效")}
                guard composer.current() else{cancel();return}
                let result=composer.attach(record,screenshot,send)
                guard result.accepted else{throw ConnectionError.message("输入框已改变，请重新添加批注")}
                _=lifetime.accept(document:documentID,currentComposer:true)
                if let warning=result.warning {notice(warning)};teardown()
            }catch {
                guard current else{return};self.error=error.localizedDescription;capturing=false
                _=try? await call("freeze",arguments:["value":false])
            }
        }
    }
    func cancel() {lifetime.cancel();teardown()}
    private func teardown() {
        guard !tornDown else{return};tornDown=true;scopeWatch?.cancel();scopeWatch=nil
        if let hostContext {
            let id=nonce
            Task {try? await TaskHostBrowserController.annotationCall(hostContext,nonce:id,action:"stop")}
        }
        if let host,host.annotationSession === self {host.annotationSession=nil}
        guard let controller else{return}
        if controller.annotationSession === self {controller.view.configuration.userContentController.removeScriptMessageHandler(forName:"fridayBrowserAnnotation",contentWorld:world)};handler=nil
        controller.view.callAsyncJavaScript("return globalThis.FridayBrowserPicker?.stop(nonce);",arguments:["nonce":nonce],in:nil,in:world,completionHandler:nil)
        if controller.annotationSession === self {controller.annotationSession=nil}
    }
    private func call(_ action:String,arguments:[String:Any]=[:])async throws->Any {
        guard current else{throw CancellationError()}
        if let hostContext {
            // Retain startup until its receipt arrives, even if the panel disappears.
            let starting=Task {try await TaskHostBrowserController.annotationCall(hostContext,nonce:nonce,action:action,arguments:arguments)}
            return try await starting.value
        }
        var values=arguments;values["nonce"]=nonce
        let script:String
        switch action {
        case "start":
            guard let path=Bundle.module.url(forResource:"BrowserAnnotationPicker",withExtension:"js") else{throw ConnectionError.message("无法加载网页批注")}
            script=try String(contentsOf:path,encoding:.utf8)+"\nreturn JSON.stringify(FridayBrowserPicker.start(nonce));"
        case "tool":script="FridayBrowserPicker.tool(nonce,tool); return JSON.stringify(FridayBrowserPicker.snapshot());"
        case "style":script="if(!FridayBrowserPicker.style(nonce,property,value))return false;return JSON.stringify(FridayBrowserPicker.snapshot());"
        case "freeze":script="return JSON.stringify(FridayBrowserPicker.freeze(nonce,value));"
        default:throw ConnectionError.message("网页批注操作无效")
        }
        return try await javascript(script,arguments:values)
    }
    private func javascript(_ script:String,arguments:[String:Any]=[:],page:Bool=false,seconds:Double=4) async throws->Any {
        guard current,let view=controller?.view else{throw CancellationError()}
        return try await withCheckedThrowingContinuation {continuation in
            let reply=TaskBrowserAnnotationReply<Any>(continuation,seconds:seconds)
            view.callAsyncJavaScript(script,arguments:arguments,in:nil,in:page ? .page:world) {result in reply.finish(result)}
        }
    }
    private func captureElements(_ value:TaskBrowserAnnotationSnapshot) async->[TaskBrowserElementDetails] {
        let fallback=value.elements.map(\.element)
        guard !fallback.isEmpty else{return fallback}
        if hostContext != nil {
            guard let result=try? await call("elements"),let text=result as? String,text.utf8.count<=2*1024*1024,let details=try? JSONDecoder().decode([TaskBrowserElementDetails].self,from:Data(text.utf8)),details.count==fallback.count else{return fallback};return details
        }
        guard let path=Bundle.module.url(forResource:"BrowserElementContext",withExtension:"js"),let wrapper=Bundle.module.url(forResource:"BrowserAnnotationContext",withExtension:"js"),let bundle=try? String(contentsOf:path,encoding:.utf8),let context=try? String(contentsOf:wrapper,encoding:.utf8) else{return fallback}
        let script=bundle+"\n"+context+"\nreturn await FridayBrowserAnnotationContext(ids,fallback,pageUrl);"
        let raw=(try? JSONSerialization.jsonObject(with:JSONEncoder().encode(fallback))) ?? []
        guard let result=try? await javascript(script,arguments:["ids":value.elements.map(\.id),"fallback":raw,"pageUrl":value.pageUrl],page:true,seconds:5.5),let text=result as? String,text.utf8.count<=2*1024*1024,let details=try? JSONDecoder().decode([TaskBrowserElementDetails].self,from:Data(text.utf8)),details.count==fallback.count else{return fallback}
        return details
    }
    private func captureImage(_ value:TaskBrowserAnnotationSnapshot) async->Data? {
        guard current,let crop=TaskBrowserAnnotationRect.union(value.rects,viewport:CGSize(width:value.viewport.width,height:value.viewport.height)) else{return nil}
        if let host {
            guard let image=try? await host.captureImage(),current else{return nil}
            return TaskBrowserAnnotationImage.crop(image,crop:crop,viewport:CGSize(width:value.viewport.width,height:value.viewport.height))
        }
        guard let view=controller?.view else{return nil}
        let scale=view.bounds.width/value.viewport.width
        let rect=CGRect(x:crop.x*scale,y:crop.y*scale,width:crop.width*scale,height:crop.height*scale).intersection(view.bounds)
        guard scale.isFinite,scale>0,!rect.isNull,rect.width>=1,rect.height>=1 else{return nil}
        let config=WKSnapshotConfiguration();config.rect=rect;config.afterScreenUpdates=true
        let result:Data?=try? await withCheckedThrowingContinuation {continuation in
            let reply=TaskBrowserAnnotationReply<Data?>(continuation,seconds:6)
            view.takeSnapshot(with:config) {image,_ in
                #if os(macOS)
                let data=image?.tiffRepresentation.flatMap {NSBitmapImageRep(data:$0)?.representation(using:.png,properties:[:])}
                #else
                let data=image?.pngData()
                #endif
                reply.finish(.success(data))
            }
        };return result
    }
}
extension TaskBrowserController:TaskBrowserAnnotationOwner {
    var annotationAvailable:Bool {url != nil && !loading && error==nil && !captureClosed}
    func annotate(_ composer:TaskBrowserAnnotationComposer) {
        guard composer.enabled,composer.current(),url != nil,!loading,error==nil else{return}
        if let annotationSession {annotationSession.cancel();return}
        let session=TaskBrowserAnnotationSession(controller:self,composer:composer);annotationSession=session
        Task {await session.start()}
    }
}

// CGImage crop coordinates follow the PNG's top-left pixel grid, independent of the native canvas scale.
@MainActor enum TaskBrowserAnnotationImage {
    static func crop(_ image:CGImage,crop:TaskBrowserAnnotationRect,viewport:CGSize)->Data? {
        guard crop.valid,viewport.width.isFinite,viewport.height.isFinite,viewport.width>0,viewport.height>0 else{return nil}
        let x=Double(image.width)/viewport.width,y=Double(image.height)/viewport.height
        let rect=CGRect(x:crop.x*x,y:crop.y*y,width:crop.width*x,height:crop.height*y).integral.intersection(CGRect(x:0,y:0,width:image.width,height:image.height))
        guard !rect.isNull,rect.width>=1,rect.height>=1,let cropped=image.cropping(to:rect) else{return nil};return TaskBrowserFrames.png(cropped)
    }
}
