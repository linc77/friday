import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Native text/IME/undo with atomic context attachments. The binding keeps a
/// portable reference document; captured source bytes stay in private storage.
struct TaskPromptEditor: View {
    @Binding var text: String
    var placeholder: String
    var enabled: Bool
    var focused: Bool
    var minimumHeight: CGFloat = 48
    var focusChanged: (Bool) -> Void
    var submit: () -> Void
    var importProviders: ([NSItemProvider]) -> Void
    var alternateSubmit: (() -> Void)? = nil
    var identity = ""
    var contexts: [TaskContextReference] = []
    var skills: [TaskComposerCatalog.Skill] = []
    var insertion: TaskContextInsertion? = nil
    var inserted: () -> Void = {}
    var openContext: (String) -> Void = { _ in }
    var mention: TaskMentionQuery? = nil
    var mentionChanged: (TaskMentionQuery?) -> Void = { _ in }
    var suggestions: [TaskFileEntry] = []
    var selectedSuggestion = 0
    var loadingSuggestions = false
    var moveSuggestion: (Int) -> Void = { _ in }
    var chooseSuggestion: () -> Void = {}
    var dismissSuggestions: () -> Void = {}
    var chooseEntry: (TaskFileEntry) -> Void = { _ in }
    var fileMentions: TaskFileMentionContext? = nil
    var selectionChanged: (NSRange) -> Void = { _ in }
    var openCitation: ((TaskAssistantCitation) -> Void)? = nil
    var maximumHeight: CGFloat = 160
    var accessibilityName = "任务要求"
    @State private var height: CGFloat = 48

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(fridayString: placeholder).font(.body).foregroundStyle(.tertiary)
                    .padding(.top, 4).padding(.leading, 3).allowsHitTesting(false)
            }
            NativeTaskPromptEditor(text: $text, height: $height, enabled: enabled, focused: focused,
                focusChanged: focusChanged, submit: submit, importProviders: importProviders, alternateSubmit: alternateSubmit,
                identity: identity, contexts: contexts, skills: skills, insertion: insertion, inserted: inserted, openContext: openContext,
                mention: mention, mentionChanged: mentionChanged, suggestions: suggestions, selectedSuggestion: selectedSuggestion,
                loadingSuggestions: loadingSuggestions, moveSuggestion: moveSuggestion, chooseSuggestion: chooseSuggestion, dismissSuggestions: dismissSuggestions, chooseEntry: chooseEntry, fileMentions: fileMentions,selectionChanged:selectionChanged,openCitation:openCitation)
                .accessibilityLabel(Text(fridayString: accessibilityName))
        }.frame(height: max(minimumHeight, min(maximumHeight, height)))
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
    var alternateSubmit: (() -> Void)? = nil
    var identity: String
    var contexts: [TaskContextReference]
    var skills: [TaskComposerCatalog.Skill]
    var insertion: TaskContextInsertion?
    var inserted: () -> Void
    var openContext: (String) -> Void
    var mention: TaskMentionQuery?
    var mentionChanged: (TaskMentionQuery?) -> Void
    var suggestions: [TaskFileEntry]
    var selectedSuggestion: Int
    var loadingSuggestions: Bool
    var moveSuggestion: (Int) -> Void
    var chooseSuggestion: () -> Void
    var dismissSuggestions: () -> Void
    var chooseEntry: (TaskFileEntry) -> Void
    var fileMentions: TaskFileMentionContext?
    var selectionChanged:(NSRange)->Void
    var openCitation:((TaskAssistantCitation)->Void)?

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = TaskPromptScrollView(); scroll.drawsBackground = false
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        let editor = TaskNativeTextView(frame: NSRect(x: 0, y: 0, width: 1, height: 48))
        editor.isRichText = true; editor.importsGraphics = false; editor.allowsUndo = true
        editor.isAutomaticLinkDetectionEnabled = false; editor.isAutomaticTextReplacementEnabled = false
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
        editor.registerForDraggedTypes([TaskFileMentionTransfer.pasteboardType, .fileURL, .png, .tiff])
        editor.delegate = context.coordinator; editor.textStorage?.setAttributedString(TaskContextText.document(text, records: contexts, skills: skills, font: editor.font!))
        editor.onLayout = { [weak editor, weak coordinator = context.coordinator] in if let editor { coordinator?.measure(editor); coordinator?.showSuggestions(editor) } }
        editor.onFocusChange = { [weak coordinator = context.coordinator] focused in
            DispatchQueue.main.async { coordinator?.parent.focusChanged(focused); if !focused { coordinator?.completion.hide() } }
        }
        scroll.documentView = editor
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let editor = scroll.documentView as? TaskNativeTextView else { return }
        let changedScope = context.coordinator.parent.identity != identity
        if changedScope { editor.delegate = nil; editor.unmarkText(); editor.delegate = context.coordinator; editor.undoManager?.removeAllActions(); context.coordinator.completion.hide() }
        context.coordinator.parent = self
        let current = TaskContextText.canonical(editor.attributedString())
        if !editor.hasMarkedText(), changedScope || current != text || context.coordinator.renderedContexts != contexts || context.coordinator.renderedSkills != skills && editor.undoManager?.canUndo != true {
            let selection = TaskContextText.modelRange(editor.selectedRange(), in: editor.attributedString()); editor.textStorage?.setAttributedString(TaskContextText.document(text, records: contexts, skills: skills, font: .systemFont(ofSize: 14)))
            editor.setSelectedRange(current == text && !changedScope ? TaskContextText.viewRange(selection, in: editor.attributedString()) : NSRange(location: editor.string.utf16.count, length: 0))
            if current != text { editor.undoManager?.removeAllActions(); context.coordinator.appliedInsertion = nil }
            context.coordinator.renderedSkills = skills; context.coordinator.renderedContexts = contexts
        }
        editor.isEditable = enabled; editor.isSelectable = true
        editor.typingAttributes = [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.labelColor]
        editor.onSubmit = { alternate in if alternate { (alternateSubmit ?? submit)() } else { submit() } }; editor.onImages = importProviders
        editor.renderPastedText = { TaskContextText.document($0, records: contexts, skills: skills, font: .systemFont(ofSize: 14)) }
        editor.onContextClick = openContext
        editor.fileMentions = fileMentions
        editor.onCompletionKey = { key in
            guard mention != nil else { return false }
            switch key { case 53: dismissSuggestions(); case 125: moveSuggestion(1); case 126: moveSuggestion(-1); case 36, 76: chooseSuggestion(); default: return false }; return true
        }
        editor.onCompositionEnd = { [weak editor, weak coordinator = context.coordinator] in if let editor { coordinator?.insertIfNeeded(editor) } }
        let focusChanged = context.coordinator.lastRequestedFocus != focused
        context.coordinator.lastRequestedFocus = focused
        if focusChanged && focused && enabled && scroll.window?.firstResponder !== editor {
            DispatchQueue.main.async { [weak editor, weak coordinator = context.coordinator] in
                guard let editor, editor.isEditable, coordinator?.parent.focused == true else { return }
                editor.window?.makeFirstResponder(editor)
            }
        } else if focusChanged && !focused && scroll.window?.firstResponder === editor { scroll.window?.makeFirstResponder(nil) }
        context.coordinator.measure(editor)
        context.coordinator.insertIfNeeded(editor)
        context.coordinator.showSuggestions(editor)
    }
    static func dismantleNSView(_ scroll: NSScrollView, coordinator: Coordinator) { coordinator.completion.hide() }
    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NativeTaskPromptEditor
        var lastRequestedFocus = false
        var renderedContexts: [TaskContextReference] = []
        var renderedSkills: [TaskComposerCatalog.Skill] = []
        private var formattingSkills = false
        var appliedInsertion: String?
        let completion = TaskContextCompletion()
        let citationPopover=TaskCitationPopover()
        init(_ parent: NativeTaskPromptEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            parent.text = TaskContextText.canonical(editor.attributedString()); formatSkills(editor); editor.typingAttributes = [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.labelColor]; changedSelection(editor); measure(editor)
        }
        func textViewDidChangeSelection(_ notification: Notification) { if let editor = notification.object as? NSTextView { changedSelection(editor) } }
        private func changedSelection(_ editor: NSTextView) {
            guard !editor.hasMarkedText(), editor.window?.firstResponder === editor else { return }
            let model = TaskContextText.canonical(editor.attributedString()); let range = TaskContextText.modelRange(editor.selectedRange(), in: editor.attributedString())
            parent.selectionChanged(range)
            let attached = editor.selectedRange().length == 0 && editor.selectedRange().location > 0 && editor.attributedString().attribute(.fridayContextToken, at: editor.selectedRange().location - 1, effectiveRange: nil) != nil
            parent.mentionChanged(!attached && range.length == 0 ? TaskContextDocument.mention(in: model, at: range.location) : nil)
        }
        private func formatSkills(_ editor: NSTextView) {
            guard !formattingSkills, !editor.hasMarkedText(), parent.insertion == nil, editor.undoManager?.isUndoing != true, editor.undoManager?.isRedoing != true else { return }
            let document = editor.attributedString(), selection = TaskContextText.modelRange(editor.selectedRange(), in: document)
            let edits = TaskContextText.skillEdits(document, skills: parent.skills, records: parent.contexts, font: .systemFont(ofSize: 14))
            guard !edits.isEmpty else { return }; formattingSkills = true
            editor.undoManager?.beginUndoGrouping()
            for edit in edits { editor.insertText(edit.replacement, replacementRange: edit.range) }
            editor.undoManager?.endUndoGrouping(); editor.setSelectedRange(TaskContextText.viewRange(selection, in: editor.attributedString()))
            formattingSkills = false; parent.text = TaskContextText.canonical(editor.attributedString())
        }
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:)); guard let url else { return false }
            if url.scheme == "friday-skill" { return true }
            if let citation=TaskAssistantCitation.parse(url.absoluteString) {
                if textView.isEditable,let composer=parent.fileMentions?.citations,composer.enabled {
                    var range=NSRange();_ = textView.attributedString().attribute(.fridayContextToken,at:charIndex,effectiveRange:&range)
                    if let target=composer.edit(citation,TaskContextText.modelRange(range,in:textView.attributedString())),let manager=textView.layoutManager,let container=textView.textContainer {
                        var rect=manager.boundingRect(forGlyphRange:manager.glyphRange(forCharacterRange:range,actualCharacterRange:nil),in:container);rect.origin.x+=textView.textContainerOrigin.x;rect.origin.y+=textView.textContainerOrigin.y
                        citationPopover.show(target:target,composer:composer,anchor:textView,rect:rect)
                    }
                } else { parent.openCitation?(citation) };return true
            }
            guard let id=TaskContextDocument.referenceID(url) else { return false };parent.openContext(id);return true
        }
        func insertIfNeeded(_ editor: TaskNativeTextView) {
            guard let insertion = parent.insertion, insertion.identity == parent.identity, appliedInsertion != insertion.id, !editor.hasMarkedText(), editor.isEditable else { return }
            let scope = parent.identity
            DispatchQueue.main.async { [weak self, weak editor] in
                guard let self, let editor, self.parent.identity == scope, self.parent.insertion?.id == insertion.id, self.appliedInsertion != insertion.id, !editor.hasMarkedText(), editor.isEditable else { return }
                self.appliedInsertion = insertion.id; self.completion.hide()
                let document = editor.attributedString(); let text = TaskContextText.canonical(document)
                if insertion.shouldInsert(in: text) {
                    let selected = TaskContextText.modelRange(editor.selectedRange(), in: document)
                    let range = TaskContextDocument.insertionRange(insertion, text: text, caret: selected)
                    let target = TaskContextText.viewRange(range, in: document)
                    editor.insertText(TaskContextText.document(TaskContextDocument.insertionText(insertion, text: text), records: self.parent.contexts, skills: self.parent.skills, font: .systemFont(ofSize: 14)), replacementRange: target)
                }
                if let caret=insertion.caret { editor.setSelectedRange(TaskContextText.viewRange(NSRange(location:caret,length:0),in:editor.attributedString())) }
                if insertion.focus { editor.window?.makeFirstResponder(editor) }
                self.parent.inserted(); self.parent.mentionChanged(nil)
            }
        }
        func showSuggestions(_ editor: TaskNativeTextView) {
            guard parent.mention != nil, editor.window?.firstResponder === editor, editor.isEditable, !editor.hasMarkedText(), let manager = editor.layoutManager, let container = editor.textContainer else { completion.hide(); return }
            let position = min(editor.selectedRange().location, max(0, editor.string.utf16.count - 1))
            let glyph = manager.glyphRange(forCharacterRange: NSRange(location: position, length: editor.string.isEmpty ? 0 : 1), actualCharacterRange: nil)
            var rect = manager.boundingRect(forGlyphRange: glyph, in: container); rect.origin.x += editor.textContainerOrigin.x; rect.origin.y += editor.textContainerOrigin.y; rect.size.height = max(18, rect.height)
            completion.show(anchor: editor, caret: rect, entries: parent.suggestions, selected: parent.selectedSuggestion, loading: parent.loadingSuggestions, choose: parent.chooseEntry)
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
    var fileMentions: TaskFileMentionContext?
    var onSubmit: ((Bool) -> Void)?
    var onImages: (([NSItemProvider]) -> Void)?
    var onLayout: (() -> Void)?
    var onFocusChange: ((Bool) -> Void)?
    var renderPastedText: ((String) -> NSAttributedString)?
    var onContextClick: ((String) -> Void)?
    var onCompletionKey: ((UInt16) -> Bool)?
    var onCompositionEnd: (() -> Void)?
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
        [TaskFileMentionTransfer.pasteboardType] + TaskImagePasteboard.readableTypes + [.string]
    }
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)), NSPasteboard.general.availableType(from: [TaskFileMentionTransfer.pasteboardType]) != nil { return isEditable && fileMentions?.enabled == true }
        if item.action == #selector(paste(_:)), TaskImagePasteboard.containsImages(in: .general) {
            return isEditable && onImages != nil
        }
        return super.validateUserInterfaceItem(item)
    }
    override func layout() { super.layout(); onLayout?() }
    override func keyDown(with event: NSEvent) {
        if !hasMarkedText(), event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty, onCompletionKey?(event.keyCode) == true { return }
        if [36, 76].contains(event.keyCode), !hasMarkedText(),
           event.modifierFlags.intersection([.option, .shift]).isEmpty {
            onSubmit?(!event.modifierFlags.intersection([.command, .control]).isEmpty); return
        }
        super.keyDown(with: event)
    }
    override func unmarkText() { super.unmarkText(); onCompositionEnd?() }
    override func copy(_ sender: Any?) {
        let range = selectedRange(); guard range.length > 0 else { return }
        let text = TaskContextText.canonical(attributedString().attributedSubstring(from: range))
        TaskContextText.copy(text)
    }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 1, event.modifierFlags.intersection([.shift, .option, .command, .control]).isEmpty, let manager = layoutManager, let container = textContainer {
            var point = convert(event.locationInWindow, from: nil); point.x -= textContainerOrigin.x; point.y -= textContainerOrigin.y
            let index = manager.characterIndex(for: point, in: container, fractionOfDistanceBetweenInsertionPoints: nil)
            if index < attributedString().length, let token = attributedString().attribute(.fridayContextToken, at: index, effectiveRange: nil) as? String {
                let glyph = manager.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
                if manager.boundingRect(forGlyphRange: glyph, in: container).contains(point) {
                    if let citation=TaskAssistantCitation.occurrences(token).first?.citation,delegate?.textView?(self,clickedOnLink:citation.href,at:index) == true { return }
                    if let ref=TaskContextDocument.occurrences(token).first { onContextClick?(ref.id);return }
                }
            }
        }
        super.mouseDown(with: event)
    }
    override func resetCursorRects() {
        super.resetCursorRects();guard let manager=layoutManager,let container=textContainer else { return }
        attributedString().enumerateAttribute(.fridayContextToken,in:NSRange(location:0,length:attributedString().length)) { token,range,_ in
            guard token != nil else { return };var rect=manager.boundingRect(forGlyphRange:manager.glyphRange(forCharacterRange:range,actualCharacterRange:nil),in:container);rect.origin.x+=textContainerOrigin.x;rect.origin.y+=textContainerOrigin.y
            addCursorRect(rect,cursor:.pointingHand)
        }
    }
    override func paste(_ sender: Any?) {
        let pasteboard = NSPasteboard.general
        if pasteboard.availableType(from: [TaskFileMentionTransfer.pasteboardType]) != nil {
            if isEditable, let payload = TaskFileMentionTransfer.read(pasteboard), let data = payload.data { _ = fileMentions?.receive(data) }; return
        }
        let providers = TaskImagePasteboard.providers(from: pasteboard)
        if !providers.isEmpty {
            onImages?(providers)
            if let text = pasteboard.string(forType: .string), !text.isEmpty,
               pasteboard.availableType(from: [.fileURL]) == nil {
                insertText(renderPastedText?(text) ?? NSAttributedString(string: text), replacementRange: selectedRange())
            }
        } else if let text = pasteboard.string(forType: TaskContextText.pasteboardType) ?? pasteboard.string(forType: .string) { insertText(renderPastedText?(text) ?? NSAttributedString(string: text), replacementRange: selectedRange()) }
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if sender.draggingPasteboard.availableType(from: [TaskFileMentionTransfer.pasteboardType]) != nil { return acceptsMentions(sender) ? .copy : [] }
        if TaskImagePasteboard.containsImages(in: sender.draggingPasteboard) { return isEditable ? .copy : [] }
        return super.draggingEntered(sender)
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if sender.draggingPasteboard.availableType(from: [TaskFileMentionTransfer.pasteboardType]) != nil { return acceptsMentions(sender) ? .copy : [] }
        if TaskImagePasteboard.containsImages(in: sender.draggingPasteboard) { return isEditable ? .copy : [] }
        return super.draggingUpdated(sender)
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if sender.draggingPasteboard.availableType(from: [TaskFileMentionTransfer.pasteboardType]) != nil { return acceptsMentions(sender) }
        if TaskImagePasteboard.containsImages(in: sender.draggingPasteboard) { return isEditable && onImages != nil }
        return super.prepareForDragOperation(sender)
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if sender.draggingPasteboard.availableType(from: [TaskFileMentionTransfer.pasteboardType]) != nil {
            guard isEditable, let payload = TaskFileMentionTransfer.read(sender.draggingPasteboard), let data = payload.data else { return false }; return fileMentions?.receive(data) == true
        }
        let providers = TaskImagePasteboard.providers(from: sender.draggingPasteboard)
        if !providers.isEmpty {
            guard isEditable, let onImages else { return false }
            onImages(providers); return true
        }
        return super.performDragOperation(sender)
    }
    private func acceptsMentions(_ sender: NSDraggingInfo) -> Bool { isEditable && fileMentions?.enabled == true && TaskFileMentionTransfer.read(sender.draggingPasteboard)?.scope == fileMentions?.scope }
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
    var alternateSubmit: (() -> Void)? = nil
    var identity: String
    var contexts: [TaskContextReference]
    var skills: [TaskComposerCatalog.Skill]
    var insertion: TaskContextInsertion?
    var inserted: () -> Void
    var openContext: (String) -> Void
    var mention: TaskMentionQuery?
    var mentionChanged: (TaskMentionQuery?) -> Void
    var suggestions: [TaskFileEntry]
    var selectedSuggestion: Int
    var loadingSuggestions: Bool
    var moveSuggestion: (Int) -> Void
    var chooseSuggestion: () -> Void
    var dismissSuggestions: () -> Void
    var chooseEntry: (TaskFileEntry) -> Void
    var fileMentions: TaskFileMentionContext?
    var selectionChanged:(NSRange)->Void
    var openCitation:((TaskAssistantCitation)->Void)?
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> TaskNativeTextView {
        let editor = TaskNativeTextView(); editor.backgroundColor = .clear
        editor.font = .preferredFont(forTextStyle: .body); editor.adjustsFontForContentSizeCategory = true
        editor.textContainerInset = UIEdgeInsets(top: 4, left: 0, bottom: 4, right: 0)
        editor.textContainer.lineFragmentPadding = 3; editor.delegate = context.coordinator
        editor.attributedText = TaskContextText.document(text, records: contexts, skills: skills, font: editor.font!)
        editor.onLayout = { [weak editor, weak coordinator = context.coordinator] in if let editor { coordinator?.measure(editor); coordinator?.showSuggestions(editor) } }
        return editor
    }
    func updateUIView(_ editor: TaskNativeTextView, context: Context) {
        let changedScope = context.coordinator.parent.identity != identity
        if changedScope { editor.delegate = nil; editor.unmarkText(); editor.delegate = context.coordinator; editor.undoManager?.removeAllActions(); context.coordinator.completion.hide() }
        context.coordinator.parent = self
        let current = TaskContextText.canonical(editor.attributedText)
        if editor.markedTextRange == nil, changedScope || current != text || context.coordinator.renderedContexts != contexts || context.coordinator.renderedSkills != skills && editor.undoManager?.canUndo != true {
            let selection = TaskContextText.modelRange(editor.selectedRange, in: editor.attributedText); editor.attributedText = TaskContextText.document(text, records: contexts, skills: skills, font: .preferredFont(forTextStyle: .body))
            editor.selectedRange = current == text && !changedScope ? TaskContextText.viewRange(selection, in: editor.attributedText) : NSRange(location: editor.text.utf16.count, length: 0)
            if current != text { editor.undoManager?.removeAllActions(); context.coordinator.appliedInsertion = nil }; context.coordinator.renderedSkills = skills; context.coordinator.renderedContexts = contexts
        }
        editor.isEditable = enabled; editor.onImages = importProviders
        editor.typingAttributes = [.font: UIFont.preferredFont(forTextStyle: .body), .foregroundColor: UIColor.label]
        editor.renderPastedText = { TaskContextText.document($0, records: contexts, skills: skills, font: .preferredFont(forTextStyle: .body)) }
        editor.onContextClick = openContext
        editor.fileMentions = fileMentions
        editor.onCompletionKey = { key in
            guard mention != nil else { return false }
            switch key { case 53: dismissSuggestions(); case 125: moveSuggestion(1); case 126: moveSuggestion(-1); case 36, 76: chooseSuggestion(); default: return false }; return true
        }
        editor.onCompositionEnd = { [weak editor, weak coordinator = context.coordinator] in if let editor { coordinator?.insertIfNeeded(editor) } }
        context.coordinator.measure(editor)
        context.coordinator.insertIfNeeded(editor); context.coordinator.showSuggestions(editor)
    }
    static func dismantleUIView(_ view: TaskNativeTextView, coordinator: Coordinator) { coordinator.completion.hide() }
    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NativeTaskPromptEditor
        var renderedContexts: [TaskContextReference] = []
        var renderedSkills: [TaskComposerCatalog.Skill] = []
        private var formattingSkills = false
        var appliedInsertion: String?
        let completion = TaskContextCompletion()
        let citationPopover=TaskCitationPopover()
        init(_ parent: NativeTaskPromptEditor) { self.parent = parent }
        func textViewDidChange(_ editor: UITextView) {
            parent.text = TaskContextText.canonical(editor.attributedText)
            if let editor = editor as? TaskNativeTextView { formatSkills(editor) }
            editor.typingAttributes = [.font: UIFont.preferredFont(forTextStyle: .body), .foregroundColor: UIColor.label]; textViewDidChangeSelection(editor); measure(editor)
        }
        func textViewDidChangeSelection(_ editor: UITextView) {
            guard editor.markedTextRange == nil, editor.isFirstResponder else { return }
            let range = TaskContextText.modelRange(editor.selectedRange, in: editor.attributedText)
            parent.selectionChanged(range)
            let attached = editor.selectedRange.length == 0 && editor.selectedRange.location > 0 && editor.attributedText.attribute(.fridayContextToken, at: editor.selectedRange.location - 1, effectiveRange: nil) != nil
            parent.mentionChanged(!attached && range.length == 0 ? TaskContextDocument.mention(in: TaskContextText.canonical(editor.attributedText), at: range.location) : nil)
        }
        private func formatSkills(_ editor: TaskNativeTextView) {
            guard !formattingSkills, editor.markedTextRange == nil, parent.insertion == nil, editor.undoManager?.isUndoing != true, editor.undoManager?.isRedoing != true else { return }
            let document = editor.attributedText!, selection = TaskContextText.modelRange(editor.selectedRange, in: document)
            let edits = TaskContextText.skillEdits(document, skills: parent.skills, records: parent.contexts, font: .preferredFont(forTextStyle: .body))
            guard !edits.isEmpty else { return }; formattingSkills = true
            editor.undoManager?.beginUndoGrouping()
            for edit in edits { editor.replaceContext(edit.range, with: edit.replacement) }
            editor.undoManager?.endUndoGrouping(); editor.selectedRange = TaskContextText.viewRange(selection, in: editor.attributedText)
            formattingSkills = false; parent.text = TaskContextText.canonical(editor.attributedText)
        }
        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            if case .link(let url) = textItem.content, url.scheme == "friday-skill" { return UIAction { _ in } }
            if case .link(let url)=textItem.content,let citation=TaskAssistantCitation.parse(url.absoluteString) {
                return UIAction { [weak self,weak textView] _ in
                    guard let self,let textView else { return }
                    if textView.isEditable,let composer=self.parent.fileMentions?.citations,composer.enabled,let target=composer.edit(citation,TaskContextText.modelRange(textItem.range,in:textView.attributedText)),let start=textView.position(from:textView.beginningOfDocument,offset:textItem.range.location),let end=textView.position(from:start,offset:textItem.range.length),let range=textView.textRange(from:start,to:end) {
                        self.citationPopover.show(target:target,composer:composer,anchor:textView,rect:textView.firstRect(for:range))
                    } else { self.parent.openCitation?(citation) }
                }
            }
            let token = textItem.range.location < textView.attributedText.length ? textView.attributedText.attribute(.fridayContextToken, at: textItem.range.location, effectiveRange: nil) as? String : nil
            let linkID: String?
            if case .link(let url) = textItem.content { linkID = TaskContextDocument.referenceID(url) } else { linkID = nil }
            let id = linkID ?? token.flatMap { TaskContextDocument.occurrences($0).first?.id }
            guard let id else { return defaultAction }
            return UIAction { [weak self] _ in self?.parent.openContext(id) }
        }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            if text == "\n", textView.markedTextRange == nil, parent.mention != nil { parent.chooseSuggestion(); return false }; return true
        }
        func textViewDidBeginEditing(_ editor: UITextView) { parent.focusChanged(true) }
        func textViewDidEndEditing(_ editor: UITextView) { parent.focusChanged(false); completion.hide() }
        func insertIfNeeded(_ editor: TaskNativeTextView) {
            guard let insertion = parent.insertion, insertion.identity == parent.identity, appliedInsertion != insertion.id, editor.markedTextRange == nil, editor.isEditable else { return }
            let scope = parent.identity
            DispatchQueue.main.async { [weak self, weak editor] in
                guard let self, let editor, self.parent.identity == scope, self.parent.insertion?.id == insertion.id, self.appliedInsertion != insertion.id, editor.markedTextRange == nil, editor.isEditable else { return }
                self.appliedInsertion = insertion.id; self.completion.hide()
                let text = TaskContextText.canonical(editor.attributedText)
                if insertion.shouldInsert(in: text) {
                    let selected = TaskContextText.modelRange(editor.selectedRange, in: editor.attributedText)
                    let range = TaskContextDocument.insertionRange(insertion, text: text, caret: selected)
                    editor.replaceContext(TaskContextText.viewRange(range, in: editor.attributedText), with: TaskContextText.document(TaskContextDocument.insertionText(insertion, text: text), records: self.parent.contexts, skills: self.parent.skills, font: .preferredFont(forTextStyle: .body)))
                }
                if let caret=insertion.caret { editor.selectedRange=TaskContextText.viewRange(NSRange(location:caret,length:0),in:editor.attributedText) }
                if insertion.focus { editor.becomeFirstResponder() }
                self.parent.inserted(); self.parent.mentionChanged(nil)
            }
        }
        func showSuggestions(_ editor: TaskNativeTextView) {
            guard parent.mention != nil, editor.isFirstResponder, editor.isEditable, editor.markedTextRange == nil, let selected = editor.selectedTextRange else { completion.hide(); return }
            completion.show(anchor: editor, caret: editor.caretRect(for: selected.end), entries: parent.suggestions, selected: parent.selectedSuggestion, loading: parent.loadingSuggestions, choose: parent.chooseEntry)
        }
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
    var fileMentions: TaskFileMentionContext?
    var onLayout: (() -> Void)?
    override func layoutSubviews() { super.layoutSubviews(); onLayout?() }
    var onImages: (([NSItemProvider]) -> Void)?
    var renderPastedText: ((String) -> NSAttributedString)?
    var onContextClick: ((String) -> Void)?
    var onCompletionKey: ((UInt16) -> Bool)?
    var onCompositionEnd: (() -> Void)?
    override func unmarkText() { super.unmarkText(); onCompositionEnd?() }
    override func copy(_ sender: Any?) {
        guard selectedRange.length > 0 else { return }; TaskContextText.copy(TaskContextText.canonical(attributedText.attributedSubstring(from: selectedRange)))
    }
    func replaceContext(_ range: NSRange, with value: NSAttributedString, restoringSelection: NSRange? = nil) {
        let original = attributedText.attributedSubstring(from: range); let selected = selectedRange
        undoManager?.registerUndo(withTarget: self) { target in target.replaceContext(NSRange(location: range.location, length: value.length), with: original, restoringSelection: selected) }
        textStorage.replaceCharacters(in: range, with: value); selectedRange = restoringSelection ?? NSRange(location: range.location + value.length, length: 0)
        delegate?.textViewDidChange?(self)
    }
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if markedTextRange == nil, let key = presses.first?.key, key.modifierFlags.intersection([.command, .control, .alternate, .shift]).isEmpty {
            let code: UInt16? = key.keyCode == .keyboardUpArrow ? 126 : key.keyCode == .keyboardDownArrow ? 125 : key.keyCode == .keyboardEscape ? 53 : key.keyCode == .keyboardReturnOrEnter ? 36 : nil
            if let code, onCompletionKey?(code) == true { return }
        }
        super.pressesBegan(presses, with: event)
    }
    override func paste(_ sender: Any?) {
        if UIPasteboard.general.contains(pasteboardTypes: [TaskFileMentionTransfer.type]) {
            if isEditable, let payload = TaskFileMentionTransfer.read(.general), let data = payload.data { _ = fileMentions?.receive(data) }; return
        }
        let providers = UIPasteboard.general.itemProviders.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) || $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        if !providers.isEmpty { onImages?(providers) }
        else if let text = TaskContextText.pasted() { replaceContext(selectedRange, with: renderPastedText?(text) ?? NSAttributedString(string: text)) }
    }
}
#endif
