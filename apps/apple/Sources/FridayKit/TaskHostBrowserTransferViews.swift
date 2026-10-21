import SwiftUI
import UniformTypeIdentifiers

struct TaskHostBrowserTransferPanel:View {
    @ObservedObject var controller:TaskHostBrowserController
    @ObservedObject var transfers:TaskHostBrowserFileTransfers
    var detached=false
    var body:some View {
        VStack(alignment:.leading,spacing:8) {
            if let chooser=transfers.chooser {
                HStack(spacing:8) {
                    FridaySymbolImage(systemName:"paperclip")
                    VStack(alignment:.leading,spacing:2) {Text(friday:chooser.multiple ? "网页请求选择文件":"网页请求选择一个文件").font(.callout);if !chooser.accept.isEmpty {Text(verbatim:chooser.accept).font(.caption).foregroundStyle(.secondary).lineLimit(1)}}
                    Spacer()
                    if transfers.uploading {Text(friday:"正在上传").font(.caption).foregroundStyle(.secondary)}else{
                        Button(friday:"取消") {transfers.cancelPicker()}.buttonStyle(FridayButtonStyle(compact:true))
                        Button(friday:"选择文件") {transfers.choose()}.buttonStyle(FridayButtonStyle(compact:true))
                    }
                }
            }
            if let item=transfers.offered {
                HStack(spacing:8) {FridaySymbolImage(systemName:"arrow.down.doc");Text(verbatim:item.fileName).font(.caption).lineLimit(1);Spacer();Button(friday:"保存") {transfers.save(item);transfers.offered=nil}.buttonStyle(FridayButtonStyle(compact:true));Button {transfers.offered=nil} label:{FridaySymbolImage(systemName:"xmark")}.buttonStyle(FridaySymbolButtonStyle())}
            }
            if !transfers.downloading.isEmpty {Text(friday:"正在下载文件").font(.caption).foregroundStyle(.secondary)}
            if let error=transfers.error {Text(fridayString:error).font(.caption).foregroundStyle(.orange).textSelection(.enabled)}
        }
        .padding(transfers.chooser != nil || transfers.offered != nil || !transfers.downloading.isEmpty || transfers.error != nil ? 10:0)
        .fileImporter(isPresented:Binding(get:{transfers.picking && controller.detached==detached},set:{if controller.detached==detached {transfers.picking=$0}}),allowedContentTypes:transfers.types,allowsMultipleSelection:transfers.multiple,onCompletion:transfers.chosen)
        .modifier(TaskHostBrowserFileExporter(controller:controller,transfers:transfers,detached:detached))
    }
}
struct TaskHostBrowserDownloadsMenu:View {
    @ObservedObject var controller:TaskHostBrowserController
    @ObservedObject var transfers:TaskHostBrowserFileTransfers
    var body:some View {
        Menu {
            if controller.state?.downloads?.isEmpty != false {Text(friday:"暂无网页下载")}
            ForEach((controller.state?.downloads ?? []).reversed()) {item in
                if item.status=="ready" {Button {transfers.save(item)} label:{Text(verbatim:item.fileName+" · "+ByteCountFormatter.string(fromByteCount:item.sizeBytes,countStyle:.file))}.disabled(transfers.downloading.contains(item.id))}
                else if item.status=="receiving" {Text(verbatim:item.fileName+" · "+String(localized:"正在下载",bundle:.module))}
                else {Text(verbatim:item.fileName+" · "+String(localized:"下载失败",bundle:.module))}
            }
        } label:{FridaySymbolImage(systemName:"arrow.down.to.line")}.fridayInteractiveCursor().help(Text(friday:"网页下载"))
    }
}
private struct TaskHostBrowserFileExporter:ViewModifier {
    @ObservedObject var controller:TaskHostBrowserController
    @ObservedObject var transfers:TaskHostBrowserFileTransfers
    let detached:Bool
    func body(content:Content)->some View {
        let item=transfers.exported
        let shown=Binding(get:{transfers.exported != nil && controller.detached==detached},set:{_ in})
        content.fileExporter(isPresented:shown,document:TaskBrowserExportDocument(source:item?.url),contentType:.data,defaultFilename:item?.url.lastPathComponent ?? "download") {_ in if let item {transfers.finishExport(item.id)}}
    }
}
