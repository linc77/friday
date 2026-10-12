import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A plain text editor with native selection, undo and IME composition. Images
/// travel through the attachment rail rather than becoming invisible rich text.
struct TaskPromptEditor: View {
    @Binding var text: String
    var placeholder: String
    var enabled: Bool
    var focused: Bool
    var minimumHeight: CGFloat = 48
    var focusChanged: (Bool) -> Void
    var submit: () -> Void
    var importProviders: ([NSItemProvider]) -> Void
    @State private var height: CGFloat = 48

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(fridayString: placeholder).font(.body).foregroundStyle(.tertiary)
                    .padding(.top, 4).padding(.leading, 3).allowsHitTesting(false)
            }
            NativeTaskPromptEditor(text: $text, height: $height, enabled: enabled, focused: focused,
                focusChanged: focusChanged, submit: submit, importProviders: importProviders)
                .accessibilityLabel(Text(friday: "任务要求"))
        }.frame(height: max(minimumHeight, min(160, height)))
    }
}

#if os(macOS)
private struct NativeTaskPromptEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    let enabled: Bool
    let focused: Bool
    let focusChanged: (Bool) -> Void
    let submit: () -> Void
    let importProviders: ([NSItemProvider]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = TaskPromptScrollView(); scroll.drawsBackground = false
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        let editor = TaskNativeTextView(frame: NSRect(x: 0, y: 0, width: 1, height: 48))
        editor.isRichText = false; editor.importsGraphics = false; editor.allowsUndo = true
        editor.drawsBackground = false; editor.font = .systemFont(ofSize: 14)
        editor.textColor = .labelColor; editor.insertionPointColor = .labelColor
        editor.textContainerInset = NSSize(width: 0, height: 4)
        editor.textContainer?.lineFragmentPadding = 3
        editor.isVerticallyResizable = true; editor.isHorizontallyResizable = false
        editor.minSize = NSSize(width: 0, height: 48)
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.autoresizingMask = [.width]
        editor.textContainer?.containerSize = NSSize(width: 1, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.widthTracksTextView = true
        editor.registerForDraggedTypes([.fileURL, .png, .tiff])
        editor.delegate = context.coordinator; editor.string = text
        editor.onLayout = { [weak editor, weak coordinator = context.coordinator] in if let editor { coordinator?.measure(editor) } }
        editor.onFocusChange = { [weak coordinator = context.coordinator] focused in
            DispatchQueue.main.async { coordinator?.parent.focusChanged(focused) }
        }
        scroll.documentView = editor
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let editor = scroll.documentView as? TaskNativeTextView else { return }
        if editor.string != text { editor.string = text }
        editor.isEditable = enabled; editor.isSelectable = true
        editor.onSubmit = submit; editor.onImages = importProviders
        let focusChanged = context.coordinator.lastRequestedFocus != focused
        context.coordinator.lastRequestedFocus = focused
        if focusChanged && focused && enabled && scroll.window?.firstResponder !== editor {
            DispatchQueue.main.async { [weak editor, weak coordinator = context.coordinator] in
                guard let editor, editor.isEditable, coordinator?.parent.focused == true else { return }
                editor.window?.makeFirstResponder(editor)
            }
        } else if focusChanged && !focused && scroll.window?.firstResponder === editor { scroll.window?.makeFirstResponder(nil) }
        context.coordinator.measure(editor)
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NativeTaskPromptEditor
        var lastRequestedFocus = false
        init(_ parent: NativeTaskPromptEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            parent.text = editor.string; measure(editor)
        }
        func measure(_ editor: NSTextView) {
            guard let manager = editor.layoutManager, let container = editor.textContainer else { return }
            manager.ensureLayout(for: container)
            let value = ceil(manager.usedRect(for: container).height + 8)
            DispatchQueue.main.async { [weak self] in
                guard let self, abs(self.parent.height - value) > 0.5 else { return }
                self.parent.height = value
            }
        }
    }
}

private final class TaskPromptScrollView: NSScrollView {
    override func tile() {
        super.tile()
        guard let editor = documentView as? NSTextView else { return }
        let viewport = contentSize
        guard viewport.width > 0, viewport.height > 0 else { return }
        editor.minSize = NSSize(width: 0, height: viewport.height)
        let size = NSSize(width: viewport.width, height: max(viewport.height, editor.frame.height))
        if editor.frame.size != size { editor.setFrameSize(size) }
    }
}

private final class TaskNativeTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onImages: (([NSItemProvider]) -> Void)?
    var onLayout: (() -> Void)?
    var onFocusChange: ((Bool) -> Void)?
    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { onFocusChange?(true) }
        return accepted
    }
    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { onFocusChange?(false) }
        return accepted
    }
    // AppKit validates the Edit > Paste command before invoking paste(_:).
    // Plain NSTextView normally advertises text formats only.
    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        TaskImagePasteboard.readableTypes + super.readablePasteboardTypes
    }
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)), TaskImagePasteboard.containsImages(in: .general) {
            return isEditable && onImages != nil
        }
        return super.validateUserInterfaceItem(item)
    }
    override func layout() { super.layout(); onLayout?() }
    override func keyDown(with event: NSEvent) {
        if [36, 76].contains(event.keyCode), !hasMarkedText(),
           event.modifierFlags.intersection([.option, .control, .shift]).isEmpty {
            onSubmit?(); return
        }
        super.keyDown(with: event)
    }
    override func paste(_ sender: Any?) {
        let pasteboard = NSPasteboard.general
        let providers = TaskImagePasteboard.providers(from: pasteboard)
        if !providers.isEmpty {
            onImages?(providers)
            if let text = pasteboard.string(forType: .string), !text.isEmpty,
               pasteboard.availableType(from: [.fileURL]) == nil {
                insertText(text, replacementRange: selectedRange())
            }
        } else { super.paste(sender) }
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if TaskImagePasteboard.containsImages(in: sender.draggingPasteboard) { return isEditable ? .copy : [] }
        return super.draggingEntered(sender)
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if TaskImagePasteboard.containsImages(in: sender.draggingPasteboard) { return isEditable ? .copy : [] }
        return super.draggingUpdated(sender)
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if TaskImagePasteboard.containsImages(in: sender.draggingPasteboard) { return isEditable && onImages != nil }
        return super.prepareForDragOperation(sender)
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let providers = TaskImagePasteboard.providers(from: sender.draggingPasteboard)
        if !providers.isEmpty {
            guard isEditable, let onImages else { return false }
            onImages(providers); return true
        }
        return super.performDragOperation(sender)
    }
}
#else
private struct NativeTaskPromptEditor: UIViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    let enabled: Bool
    let focused: Bool
    let focusChanged: (Bool) -> Void
    let submit: () -> Void
    let importProviders: ([NSItemProvider]) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> TaskNativeTextView {
        let editor = TaskNativeTextView(); editor.backgroundColor = .clear
        editor.font = .preferredFont(forTextStyle: .body); editor.adjustsFontForContentSizeCategory = true
        editor.textContainerInset = UIEdgeInsets(top: 4, left: 0, bottom: 4, right: 0)
        editor.textContainer.lineFragmentPadding = 3; editor.delegate = context.coordinator
        editor.text = text
        editor.onLayout = { [weak editor, weak coordinator = context.coordinator] in if let editor { coordinator?.measure(editor) } }
        return editor
    }
    func updateUIView(_ editor: TaskNativeTextView, context: Context) {
        context.coordinator.parent = self
        if editor.text != text { editor.text = text }
        editor.isEditable = enabled; editor.onImages = importProviders
        context.coordinator.measure(editor)
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NativeTaskPromptEditor
        init(_ parent: NativeTaskPromptEditor) { self.parent = parent }
        func textViewDidChange(_ editor: UITextView) { parent.text = editor.text; measure(editor) }
        func textViewDidBeginEditing(_ editor: UITextView) { parent.focusChanged(true) }
        func textViewDidEndEditing(_ editor: UITextView) { parent.focusChanged(false) }
        func measure(_ editor: UITextView) {
            guard editor.bounds.width > 0 else { return }
            let value = editor.sizeThatFits(CGSize(width: editor.bounds.width, height: .greatestFiniteMagnitude)).height
            DispatchQueue.main.async { [weak self] in
                guard let self, abs(self.parent.height - value) > 0.5 else { return }; self.parent.height = value
            }
        }
    }
}
private final class TaskNativeTextView: UITextView {
    var onLayout: (() -> Void)?
    override func layoutSubviews() { super.layoutSubviews(); onLayout?() }
    var onImages: (([NSItemProvider]) -> Void)?
    override func paste(_ sender: Any?) {
        let providers = UIPasteboard.general.itemProviders.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        if !providers.isEmpty { onImages?(providers) } else { super.paste(sender) }
    }
}
#endif
