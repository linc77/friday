import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor final class TaskHostBrowserFileTransfers:ObservableObject {
    weak var controller:TaskHostBrowserController?
    @Published var picking=false
    @Published private(set) var uploading=false
    @Published private(set) var downloading=Set<String>()
    @Published var exported:TaskBrowserExport?
    @Published private(set) var error:String?
    @Published var offered:TaskHostBrowserSnapshot.Download?
    private var selected:TaskHostBrowserSnapshot.Chooser?
    private var upload:Task<Void,Never>?
    private var downloads:[String:Task<Void,Never>]=[:]
    private var seen=Set<String>()
    private var exportQueue:[TaskBrowserExport]=[]
    private var closed=false
    init(controller:TaskHostBrowserController) {self.controller=controller}
    var chooser:TaskHostBrowserSnapshot.Chooser? {controller?.activeChooser}
    var types:[UTType] {TaskHostBrowserUploadBundle.types(selected?.accept ?? chooser?.accept ?? "")}
    var multiple:Bool {selected?.multiple ?? chooser?.multiple ?? false}
    func reconcile() {
        if let selected,chooser?.id != selected.id {picking=false;self.selected=nil;upload?.cancel()}
        guard let controller else{return}
        for item in controller.state?.downloads ?? [] where item.status=="ready" && seen.insert(item.id).inserted {
            if controller.ownsDownloadOffer(item) {offered=item}
        }
    }
    func choose() {guard !uploading,let chooser else{return};selected=chooser;picking=true;error=nil}
    func chosen(_ result:Result<[URL],Error>) {
        guard let selected,chooser?.id==selected.id else{return};self.selected=nil
        switch result {case .success(let urls):send(urls,chooser:selected)
        case .failure(let error):if (error as NSError).code==NSUserCancelledError {send([],chooser:selected)}else{self.error=error.localizedDescription}}
    }
    func cancelPicker() {guard let chooser,!uploading else{return};send([],chooser:chooser)}
    private func send(_ urls:[URL],chooser:TaskHostBrowserSnapshot.Chooser) {
        guard upload==nil,let controller,controller.activeChooser?.id==chooser.id else{return};uploading=true;error=nil
        upload=Task { [weak self,weak controller] in
            guard let self,let controller else{return}
            var bundle:TaskHostBrowserUploadBundle?
            defer{bundle?.remove();uploading=false;upload=nil}
            do {
                let preparing=Task.detached(priority:.userInitiated) {try TaskHostBrowserUploadBundle.build(urls,multiple:chooser.multiple)}
                let prepared=try await withTaskCancellationHandler(operation:{try await preparing.value},onCancel:{preparing.cancel()});bundle=prepared
                guard !Task.isCancelled else{throw CancellationError()}
                let context=try await controller.uploadContext(chooser:chooser.id,digest:prepared.digest)
                var request=try context.transport.request("upload",query:context.query);request.httpMethod="POST";request.setValue(prepared.contentType,forHTTPHeaderField:"Content-Type");request.timeoutInterval=120
                let (data,response)=try await context.transport.session.upload(for:request,fromFile:prepared.url)
                guard let http=response as? HTTPURLResponse,(200..<300).contains(http.statusCode) else{throw ConnectionError.message((try? JSONDecoder().decode(APIError.self,from:data).error) ?? "上传文件未完成")}
                guard !Task.isCancelled else{return};controller.acceptTransferReply(try JSONDecoder().decode(TaskHostBrowserSnapshot.self,from:data))
            }catch {if !Task.isCancelled {self.error=error.localizedDescription}}
        }
    }
    func save(_ item:TaskHostBrowserSnapshot.Download) {
        guard !closed,downloads[item.id]==nil,item.status=="ready",let controller,let context=controller.downloadContext(item) else{return}
        downloading.insert(item.id);error=nil
        downloads[item.id]=Task { [weak self] in
            guard let self else{return};defer{downloading.remove(item.id);downloads.removeValue(forKey:item.id)}
            var saved:URL?
            do {
                let request=try context.transport.request("download",query:context.query)
                let (temporary,response)=try await context.transport.session.download(for:request)
                defer{try? FileManager.default.removeItem(at:temporary)}
                guard let http=response as? HTTPURLResponse,http.statusCode==200 else{throw ConnectionError.message("下载文件不存在或尚未完成")}
                let attributes=try FileManager.default.attributesOfItem(atPath:temporary.path),size=(attributes[.size] as? NSNumber)?.int64Value ?? -1
                guard size==item.sizeBytes,size>=0,size<=1024*1024*1024 else{throw ConnectionError.message("下载文件大小与主机记录不一致")}
                let target=try TaskBrowserDownloadFiles.temporary(TaskHostBrowserUploadBundle.name(item.fileName));saved=target
                try FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:target.deletingLastPathComponent().path)
                try FileManager.default.moveItem(at:temporary,to:target);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:target.path)
                guard !Task.isCancelled,!closed else{throw CancellationError()}
                let export=TaskBrowserExport(url:target);if exported==nil {exported=export}else{exportQueue.append(export)};saved=nil
            }catch {if !Task.isCancelled {self.error=error.localizedDescription}}
            if let saved {TaskBrowserDownloadFiles.removeTemporary(saved)}
        }
    }
    func finishExport(_ id:UUID) {
        guard exported?.id==id else{return};if let url=exported?.url {TaskBrowserDownloadFiles.removeTemporary(url)};exported=nil
        Task { [weak self] in try? await Task.sleep(for:.milliseconds(150));guard let self,!closed,exported==nil,!exportQueue.isEmpty else{return};exported=exportQueue.removeFirst() }
    }
    func cancel() {closed=true;picking=false;selected=nil;upload?.cancel();for value in downloads.values {value.cancel()};for value in exportQueue {TaskBrowserDownloadFiles.removeTemporary(value.url)};exportQueue=[];if let exported {TaskBrowserDownloadFiles.removeTemporary(exported.url)};exported=nil}
}

@MainActor enum TaskHostBrowserNativeClipboard {
    static func write(_ text:String) {
        #if os(macOS)
        NSPasteboard.general.clearContents();NSPasteboard.general.setString(text,forType:.string)
        #else
        UIPasteboard.general.string=text
        #endif
    }
    static func read()->String? {
        #if os(macOS)
        NSPasteboard.general.string(forType:.string)
        #else
        UIPasteboard.general.string
        #endif
    }
}
