import SwiftUI
import UniformTypeIdentifiers

struct TaskHostBrowserArtifactExporter:ViewModifier {
    @ObservedObject var controller:TaskHostBrowserController
    var detached=false
    func body(content:Content)->some View {
        let url=controller.exported?.url
        let shown=Binding(get:{controller.exported != nil && controller.detached==detached},set:{if !$0,controller.detached==detached {controller.exported=nil}})
        content.fileExporter(isPresented:shown,document:TaskBrowserExportDocument(source:url),contentType:url?.pathExtension=="png" ? .png:url?.pathExtension=="mp4" ? .mpeg4Movie:.data,defaultFilename:url?.lastPathComponent ?? "page") {_ in controller.exported=nil}
    }
}
