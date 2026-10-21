import Foundation
import ObjectiveC
import SwiftUI

/// These selectors are defined by WebKit's Cocoa SPI. Check both availability and ABI before use.
/// https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h
@MainActor enum TaskBrowserNativeControls {
    private static func method(_ target:NSObject,_ name:String,returns:Set<String>,argument:String?=nil)->Method? {
        let selector=NSSelectorFromString(name)
        guard target.responds(to:selector),let method=class_getInstanceMethod(type(of:target),selector),method_getNumberOfArguments(method)==(argument==nil ? 2:3) else{return nil}
        let result=method_copyReturnType(method);defer{free(result)}
        guard returns.contains(String(cString:result)) else{return nil}
        if let argument {guard let type=method_copyArgumentType(method,2) else{return nil};defer{free(type)};guard String(cString:type)==argument else{return nil}}
        return method
    }
    static func playing(_ target:NSObject)->Bool? {
        guard let method=method(target,"_isPlayingAudio",returns:["B","c"]) else{return nil}
        typealias Getter=@convention(c)(AnyObject,Selector)->Bool
        return unsafeBitCast(method_getImplementation(method),to:Getter.self)(target,NSSelectorFromString("_isPlayingAudio"))
    }
    static func mute(_ target:NSObject,_ muted:Bool)->Bool {
        guard let read=method(target,"_mediaMutedState",returns:["Q"]),let write=method(target,"_setPageMuted:",returns:["v"],argument:"Q") else{return false}
        typealias Getter=@convention(c)(AnyObject,Selector)->UInt
        typealias Setter=@convention(c)(AnyObject,Selector,UInt)->Void
        let bits=unsafeBitCast(method_getImplementation(read),to:Getter.self)(target,NSSelectorFromString("_mediaMutedState"))
        // Preserve microphone, camera and screen-capture mute bits.
        let value=muted ? bits|1:bits & ~UInt(1)
        unsafeBitCast(method_getImplementation(write),to:Setter.self)(target,NSSelectorFromString("_setPageMuted:"),value);return true
    }
    static func canMute(_ target:NSObject)->Bool {method(target,"_mediaMutedState",returns:["Q"]) != nil && method(target,"_setPageMuted:",returns:["v"],argument:"Q") != nil}
    static func inspector(_ target:NSObject)->NSObject? {
        guard method(target,"_inspector",returns:["@"]) != nil else{return nil}
        return target.perform(NSSelectorFromString("_inspector"))?.takeUnretainedValue() as? NSObject
    }
    @discardableResult static func inspect(_ target:NSObject,show:Bool)->Bool {
        guard let inspector=inspector(target),let method=method(inspector,show ? "show":"close",returns:["v"]) else{return false}
        typealias Action=@convention(c)(AnyObject,Selector)->Void
        unsafeBitCast(method_getImplementation(method),to:Action.self)(inspector,NSSelectorFromString(show ? "show":"close"));return true
    }
    @discardableResult static func flushCookies(_ target:NSObject,completion:@escaping ()->Void)->Bool {
        let name="_flushCookiesToDiskWithCompletionHandler:"
        guard let method=method(target,name,returns:["v"],argument:"@?") else{return false}
        typealias Completion=@convention(block)()->Void
        typealias Action=@convention(c)(AnyObject,Selector,Completion)->Void
        let callback:Completion=completion
        unsafeBitCast(method_getImplementation(method),to:Action.self)(target,NSSelectorFromString(name),callback);return true
    }
}
extension TaskBrowserController {
    var canMuteAudio:Bool {!closed && TaskBrowserNativeControls.canMute(view)}
    var canInspectPage:Bool {
        #if os(macOS)
        !closed && view.responds(to:NSSelectorFromString("_inspector"))
        #else
        false
        #endif
    }
    func setAudioMuted(_ muted:Bool) {
        guard !closed else{return}
        if TaskBrowserNativeControls.mute(view,muted) {audioMuted=muted;refreshAudio()}else{message="当前系统不支持网页静音"}
    }
    func refreshAudio() {guard !closed else{return};if let value=TaskBrowserNativeControls.playing(view) {audible=value}}
    func openDevTools() {
        #if os(macOS)
        guard !closed else{return};if !TaskBrowserNativeControls.inspect(view,show:true) {message="当前系统无法打开网页开发工具"}
        #endif
    }
}
struct TaskBrowserAudioButton:View {
    @ObservedObject var controller:TaskBrowserController
    var body:some View {
        Group {
            if controller.audioMuted || controller.audible {
                Button {controller.setAudioMuted(!controller.audioMuted)} label:{FridaySymbolImage(systemName:controller.audioMuted ? "speaker.slash":"speaker.wave.2")}
                    .disabled(!controller.canMuteAudio).help(Text(friday:controller.audioMuted ? "取消网页静音":"网页静音")).accessibilityLabel(Text(friday:controller.audioMuted ? "取消网页静音":"网页静音"))
            }
        }
    }
}
