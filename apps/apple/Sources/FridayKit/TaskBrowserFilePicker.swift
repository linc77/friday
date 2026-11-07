#if os(iOS)
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct TaskBrowserFilePicker:UIViewControllerRepresentable {
    let request:TaskBrowserUpload
    let completion:([URL]?)->Void
    func makeCoordinator()->Coordinator {Coordinator(completion)}
    func makeUIViewController(context:Context)->UIDocumentPickerViewController {
        let controller=UIDocumentPickerViewController(forOpeningContentTypes:request.directories ? [.item,.folder]:[.item],asCopy:true)
        controller.allowsMultipleSelection=request.multiple;controller.delegate=context.coordinator;return controller
    }
    func updateUIViewController(_ controller:UIDocumentPickerViewController,context:Context) {}
    static func dismantleUIViewController(_ controller:UIDocumentPickerViewController,coordinator:Coordinator) {coordinator.finish(nil)}
    @MainActor final class Coordinator:NSObject,UIDocumentPickerDelegate {
        private var completion:(([URL]?)->Void)?
        init(_ completion:@escaping([URL]?)->Void) {self.completion=completion}
        func finish(_ urls:[URL]?) {let callback=completion;completion=nil;callback?(urls)}
        func documentPicker(_ controller:UIDocumentPickerViewController,didPickDocumentsAt urls:[URL]) {finish(urls)}
        func documentPickerWasCancelled(_ controller:UIDocumentPickerViewController) {finish(nil)}
    }
}
#endif
