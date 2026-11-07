import SwiftUI
import WebKit
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

extension TaskBrowserController {
    var frames:TaskBrowserFrames {if let framePump {return framePump};let value=TaskBrowserFrames(view:view);framePump=value;return value}
}

extension TaskBrowserCaptureOwner {
    func capturePageArtifact() {
        guard !captureClosed,captureAvailable,!capturing,!TaskBrowserCaptureRegistry.shared.terminating,let page=captureURL else{return};capturing=true;let document=captureDocument,operationID=UUID()
        let operation=Task {
            defer {capturing=false;TaskBrowserCaptureRegistry.shared.remove(operationID)}
            do {
                let image=try await captureImage();guard !captureClosed,captureDocument==document else{return}
                guard let data=TaskBrowserFrames.png(image) else{throw ConnectionError.message("无法截取页面")}
                let store=try TaskBrowserArtifactStore(scope:artifactScope),artifact=try store.save(data,page:page)
                publish(artifact,store:store)
            }catch {if !captureClosed {message=error.localizedDescription};throw error}
        }
        TaskBrowserCaptureRegistry.shared.register(id:operationID,wait:{try await operation.value})
    }
    func publish(_ artifact:TaskBrowserArtifact,store:TaskBrowserArtifactStore) {guard !captureClosed else{return};artifacts=store.recent();capturedArtifact=artifact}
    func startRecording(frameRate:Int) {
        guard !captureClosed,captureAvailable,!TaskBrowserCaptureRegistry.shared.terminating,recordingSession==nil,captureURL != nil else{return}
        do {let session=try TaskBrowserRecordingSession(controller:self,frameRate:TaskBrowserCapturePolicy.frameRate(frameRate));recordingSession=session;session.start()}
        catch {message=error.localizedDescription}
    }
    func artifactURL(_ artifact:TaskBrowserArtifact)throws->URL {try TaskBrowserArtifactStore(scope:artifactScope).url(artifact)}
    func copyArtifact(_ artifact:TaskBrowserArtifact,image:Bool) {
        do {
            let file=try artifactURL(artifact)
            #if os(macOS)
            NSPasteboard.general.clearContents()
            if image {let data=try Data(contentsOf:file);guard data.count<=64*1024*1024,NSPasteboard.general.setData(data,forType:.png) else{throw ConnectionError.message("无法复制图片")}}
            else {NSPasteboard.general.setString(file.path,forType:.string)}
            #else
            if image {let data=try Data(contentsOf:file);guard data.count<=64*1024*1024 else{throw ConnectionError.message("无法复制图片")};UIPasteboard.general.setData(data,forPasteboardType:UTType.png.identifier)}else{UIPasteboard.general.string=file.path}
            #endif
            message=image ? "图片已复制":"路径已复制"
        }catch {message=error.localizedDescription}
    }
    func exportArtifact(_ artifact:TaskBrowserArtifact) {do {exported=TaskBrowserExport(url:try artifactURL(artifact))}catch{message=error.localizedDescription}}
    #if os(macOS)
    func revealArtifact(_ artifact:TaskBrowserArtifact) {do {NSWorkspace.shared.activateFileViewerSelecting([try artifactURL(artifact)])}catch{message=error.localizedDescription}}
    #endif
}

struct TaskBrowserArtifactActions<Controller:TaskBrowserCaptureOwner>:View {
    @ObservedObject var controller:Controller
    let artifact:TaskBrowserArtifact
    var body:some View {
        Group {
            if !artifact.recording {Button(friday:"复制图片") {controller.copyArtifact(artifact,image:true)}}
            Button(friday:"复制路径") {controller.copyArtifact(artifact,image:false)}
            #if os(macOS)
            Button(friday:"在 Finder 中显示") {controller.revealArtifact(artifact)}
            #endif
            Button(friday:"导出文件") {controller.exportArtifact(artifact)}
        }
    }
}
struct TaskBrowserArtifactNotice<Controller:TaskBrowserCaptureOwner>:View {
    @ObservedObject var controller:Controller
    var body:some View {
        if let artifact=controller.capturedArtifact {
            VStack(alignment:.leading,spacing:8) {
                HStack {FridaySymbolImage(systemName:artifact.recording ? "video":"camera");Text(friday:artifact.recovered==true ? "录屏已恢复":artifact.recording ? "录屏已保存":"截图已保存").font(.caption.weight(.medium));Spacer();Button {controller.capturedArtifact=nil} label:{FridaySymbolImage(systemName:"xmark")}.buttonStyle(FridaySymbolButtonStyle())}
                Text(verbatim:artifact.name).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                HStack {if !artifact.recording {Button(friday:"复制图片") {controller.copyArtifact(artifact,image:true)}.buttonStyle(FridayButtonStyle(compact:true))};Spacer();Menu {TaskBrowserArtifactActions(controller:controller,artifact:artifact)} label:{Text(friday:"文件操作")}.fridayInteractiveCursor()}
                if let message=controller.message {Text(fridayString:message).font(.caption2).foregroundStyle(.secondary)}
            }.padding(12).background(.regularMaterial,in:RoundedRectangle(cornerRadius:9)).padding(10)
        }
    }
}
struct TaskBrowserCaptureButton<Controller:TaskBrowserCaptureOwner>:View {
    @ObservedObject var controller:Controller
    @AppStorage("friday.browser.recording.fps") private var fps=30
    var body:some View {
        Group {
            if let session=controller.recordingSession {TaskBrowserRecordingStopButton(session:session).contextMenu {Button(friday:"截取网页") {controller.capture()}}}
            else {
                Button {
                    #if os(macOS)
                    if NSEvent.modifierFlags.contains(.shift) {controller.startRecording(frameRate:fps)}else{controller.capture()}
                    #else
                    controller.capture()
                    #endif
                } label:{FridaySymbolImage(systemName:"camera")}
                    .help(Text(friday:"截图 · Shift 点击开始录屏")).disabled(!controller.captureAvailable || controller.capturing)
                    .contextMenu {Button(friday:"截取网页") {controller.capture()};Button(friday:"开始录屏") {controller.startRecording(frameRate:fps)}}
            }
        }
    }
}
private struct TaskBrowserRecordingStopButton:View {
    @ObservedObject var session:TaskBrowserRecordingSession
    var body:some View {Button {session.stop()} label:{FridaySymbolImage(systemName:session.phase == .stopping ? "hourglass":"stop.circle.fill").foregroundStyle(.red)}.disabled(session.phase == .stopping || session.phase == .finished).help(Text(friday:session.phase == .stopping ? "正在保存录屏…":"停止录屏"))}
}

struct TaskBrowserRecordingPreferences:View {
    @AppStorage("friday.browser.recording.fps") private var fps=30
    @AppStorage("friday.browser.recording.keys") private var keys=false
    @AppStorage("friday.browser.recording.mouse") private var mouse=false
    var body:some View {
        Menu {
            Picker(selection:$fps) {ForEach(TaskBrowserCapturePolicy.frameRates,id:\.self) {value in Text(verbatim:"\(value) fps").tag(value)}} label:{Text(friday:"录屏帧率")}
            Toggle(isOn:$keys) {Text(friday:"显示按键")}.fridayInteractiveCursor()
            Toggle(isOn:$mouse) {Text(friday:"显示鼠标点击")}.fridayInteractiveCursor()
        } label:{Text(friday:"录屏设置")}
    }
}
struct TaskBrowserRecordingStatus:View {
    @ObservedObject var session:TaskBrowserRecordingSession
    var body:some View {
        HStack(spacing:8) {
            FridaySymbolImage(systemName:"record.circle").foregroundStyle(.red)
            if session.phase == .starting {Text(friday:"正在准备录屏…")}
            else if session.phase == .stopping {Text(friday:"正在保存录屏…")}
            else {TimelineView(.periodic(from:.now,by:1)) {_ in let seconds=Int(session.elapsed());Text(verbatim:String(format:"%02d:%02d",seconds/60,seconds%60)).monospacedDigit()}}
            Spacer();Button(friday:"停止录屏") {session.stop()}.buttonStyle(FridayButtonStyle(compact:true)).disabled(session.phase == .stopping)
        }.font(.caption).padding(8).background(.primary.opacity(0.025))
    }
}
