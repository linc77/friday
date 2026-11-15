#if os(iOS)
import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Keep the sheet separate from the embedded picker. A modally presented
/// PHPicker collapses its controls at smaller detents on iOS; its inline layout
/// keeps collection navigation and selection actions inside the content bounds.
struct MobileNotePhotoPicker: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    let finish: ([PHPickerResult]) -> Void

    func makeUIViewController(context: Context) -> Presenter { Presenter() }
    func updateUIViewController(_ presenter: Presenter, context: Context) {
        presenter.finish = { results in
            isPresented = false
            finish(results)
        }
        presenter.wantsPresentation = isPresented
        presenter.updatePresentation()
    }
    static func dismantleUIViewController(_ presenter: Presenter, coordinator: ()) {
        presenter.tearDown()
    }

    final class Presenter: UIViewController, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
        var wantsPresentation = false
        var finish: ([PHPickerResult]) -> Void = { _ in }
        private var activeSheet: PickerSheet?
        private var dismissing = false

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            updatePresentation()
        }

        func updatePresentation() {
            guard !dismissing else { return }
            guard wantsPresentation else {
                if activeSheet != nil { closePicker(results: nil) }
                return
            }
            guard viewIfLoaded?.window != nil, activeSheet == nil, presentedViewController == nil else { return }
            let container = PickerSheet()
            container.picker.delegate = self
            container.modalPresentationStyle = .pageSheet
            if let sheet = container.sheetPresentationController {
                let initial = UISheetPresentationController.Detent.Identifier("notePhotos")
                sheet.detents = [.custom(identifier: initial) { $0.maximumDetentValue * 0.65 }, .large()]
                sheet.selectedDetentIdentifier = initial
                sheet.prefersGrabberVisible = true
            }
            container.presentationController?.delegate = self
            activeSheet = container
            present(container, animated: true)
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard picker === activeSheet?.picker else { return }
            closePicker(results: results)
        }

        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            guard presentationController.presentedViewController === activeSheet else { return }
            activeSheet = nil
            wantsPresentation = false
            finish([])
        }

        func tearDown() {
            wantsPresentation = false
            finish = { _ in }
            activeSheet?.dismiss(animated: false)
            activeSheet = nil
        }

        private func closePicker(results: [PHPickerResult]?) {
            guard let container = activeSheet, !dismissing else { return }
            dismissing = true
            wantsPresentation = false
            container.dismiss(animated: true) { [weak self] in
                guard let self else { return }
                self.activeSheet = nil
                self.dismissing = false
                if let results { self.finish(results) }
            }
        }
    }

    final class PickerSheet: UIViewController {
        let picker: PHPickerViewController = {
            var configuration = PHPickerConfiguration()
            configuration.filter = .images
            configuration.selection = .ordered
            configuration.selectionLimit = 0 // The system maximum; no 20-photo limit.
            configuration.preferredAssetRepresentationMode = .current
            configuration.edgesWithoutContentMargins = [] // Keep the native top accessories visible.
            return PHPickerViewController(configuration: configuration)
        }()

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .systemBackground
            // Explicit containment opts in to the supported embedded picker.
            // Only this outer controller participates in sheet detent changes.
            addChild(picker)
            picker.view.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(picker.view)
            NSLayoutConstraint.activate([
                picker.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
                picker.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                picker.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                picker.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
            ])
            picker.didMove(toParent: self)
        }
    }

    static func load(_ result: PHPickerResult) async throws -> (Data, String) {
        let provider = result.itemProvider
        let identifier = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true }
            ?? UTType.image.identifier
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: identifier) { data, error in
                if let error { continuation.resume(throwing: error) }
                else if let data { continuation.resume(returning: data) }
                else { continuation.resume(throwing: CocoaError(.fileReadCorruptFile)) }
            }
        }
        let suffix = UTType(identifier)?.preferredFilenameExtension ?? "png"
        return (data, provider.suggestedName ?? "照片.\(suffix)")
    }
}
#endif
