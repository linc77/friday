import SwiftUI
#if os(macOS)
import AppKit
private typealias FileFont = NSFont
private typealias FileColor = NSColor
#else
import UIKit
private typealias FileFont = UIFont
private typealias FileColor = UIColor
#endif

struct TaskSourceFileView: View {
    let source: String; let language: String; let identity: String; let line: Int?; let reveal: Int; let wrapping: Bool
    var editable = false
    var change: (String) -> Void = { _ in }
    var edited: ((String, Bool, Bool, TaskSourceTextEdit?) -> Void)? = nil
    var annotations: [TaskFileLineAnnotation] = []
    var canComment = false
    var beginComment: (TaskSourceLineRange) -> Void = { _ in }
    var submitComment: (UUID, String) -> Void = { _, _ in }
    var removeComment: (UUID) -> Void = { _ in }
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.locale) private var locale
    @State private var highlight: CodeHighlight?
    @State private var highlightedKey: String?
    @State private var highlightID = UUID()
    private var key: String { identity + ":" + language + ":" + String(colorScheme == .dark) + ":" + source }
    var body: some View {
        TaskSourceNativeView(source: source, highlight: highlightedKey == key ? highlight : nil, highlightID: highlightedKey == key && highlight != nil ? highlightID : nil,
            identity: identity, line: line, reveal: reveal, wrapping: wrapping, editable: editable, change: change, edited: edited,
            annotations: annotations, canComment: canComment, beginComment: beginComment, submitComment: submitComment, removeComment: removeComment, locale: locale, dark: colorScheme == .dark)
            .task(id: key) {
                let request = key
                if editable { do { try await Task.sleep(for: .milliseconds(80)) } catch { return } }
                let value = await CodeHighlighter.shared.highlight(source, language: language, dark: colorScheme == .dark)
                if !Task.isCancelled { highlight = value; highlightedKey = request; highlightID = UUID() }
            }
    }
}

private enum FileSourceText {
    /// Updating attributes alone keeps native typing, undo groups and marked text intact.
    @MainActor static func apply(_ value: NSAttributedString, to storage: NSTextStorage) {
        storage.beginEditing()
        value.enumerateAttributes(in: NSRange(location: 0, length: value.length)) { attributes, range, _ in storage.setAttributes(attributes, range: range) }
        storage.endEditing()
    }
    @MainActor static func attributed(_ source: String, highlight: CodeHighlight?) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle(); paragraph.minimumLineHeight = 20
        let font = FileFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        #if os(macOS)
        let foreground = NSColor.textColor
        #else
        let foreground = UIColor.label
        #endif
        let result = NSMutableAttributedString(string: source, attributes: [.font: font, .foregroundColor: foreground, .paragraphStyle: paragraph])
        guard let highlight, highlight.text == source else { return result }
        var offset = 0, fonts: [Int: FileFont] = [0: font]
        for token in highlight.tokens {
            let length = (token.text as NSString).length, range = NSRange(location: offset, length: length); offset += length
            if let color = color(token.color) { result.addAttribute(.foregroundColor, value: color, range: range) }
            let traits = token.style & 3
            if fonts[traits] == nil {
                #if os(macOS)
                var value = font; if traits & 1 != 0 { value = NSFontManager.shared.convert(value, toHaveTrait: .italicFontMask) }; if traits & 2 != 0 { value = NSFontManager.shared.convert(value, toHaveTrait: .boldFontMask) }; fonts[traits] = value
                #else
                var value: UIFontDescriptor.SymbolicTraits = []; if traits & 1 != 0 { value.insert(.traitItalic) }; if traits & 2 != 0 { value.insert(.traitBold) }
                fonts[traits] = font.fontDescriptor.withSymbolicTraits(value).map { UIFont(descriptor: $0, size: 13) } ?? font
                #endif
            }
            result.addAttribute(.font, value: fonts[traits] ?? font, range: range)
            if token.style & 4 != 0 { result.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range) }
            if token.style & 8 != 0 { result.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range) }
        }
        return result
    }
    static func color(_ hex: String) -> FileColor? {
        guard hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return FileColor(Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255))
    }
}

#if os(macOS)
private final class FileLineRuler: NSRulerView {
    var lines = TaskSourceLines("")
    var canComment = false
    var beginComment: (TaskSourceLineRange) -> Void = { _ in }
    private var anchor: Int?, hover: Int?
    private var tracking: NSTrackingArea?
    override func updateTrackingAreas() {
        super.updateTrackingAreas(); if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self); addTrackingArea(area); tracking = area
    }
    override func resetCursorRects() { super.resetCursorRects(); if canComment { addCursorRect(bounds, cursor: .pointingHand) } }
    private func number(_ event: NSEvent) -> Int? {
        guard let text = clientView as? NSTextView, let layout = text.layoutManager, let container = text.textContainer else { return nil }
        var point = text.convert(event.locationInWindow, from: nil); point.x = 0; point.y -= text.textContainerOrigin.y
        return lines.number(at: layout.characterIndex(for: point, in: container, fractionOfDistanceBetweenInsertionPoints: nil))
    }
    override func mouseMoved(with event: NSEvent) { hover = canComment ? number(event) : nil; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hover = nil; needsDisplay = true }
    override func mouseDown(with event: NSEvent) { guard canComment else { return }; anchor = number(event); select(event) }
    override func mouseDragged(with event: NSEvent) { guard anchor != nil else { return }; (clientView as? NSTextView)?.autoscroll(with: event); select(event) }
    private func select(_ event: NSEvent) {
        guard let anchor, let number = number(event), let text = clientView as? NSTextView else { return }
        let range = TaskSourceLineRange(anchor, number), first = lines.range(line: range.start), last = lines.range(line: range.end)
        text.setSelectedRange(NSRange(location: first.location, length: NSMaxRange(last) - first.location)); needsDisplay = true
    }
    override func mouseUp(with event: NSEvent) {
        guard canComment, let anchor, let number = number(event), let text = clientView as? NSTextView else { self.anchor = nil; return }
        self.anchor = nil; text.window?.makeFirstResponder(nil)
        text.setSelectedRange(NSRange(location: lines.range(line: number).location, length: 0)); beginComment(TaskSourceLineRange(anchor, number))
    }
    override var isFlipped: Bool { true }
    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let text = clientView as? NSTextView, let layout = text.layoutManager, let container = text.textContainer else { return }
        let visible = text.visibleRect.offsetBy(dx: -text.textContainerOrigin.x, dy: -text.textContainerOrigin.y)
        let glyphs = layout.glyphRange(forBoundingRect: visible, in: container)
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: NSColor.secondaryLabelColor]
        layout.enumerateLineFragments(forGlyphRange: glyphs) { line, _, _, range, _ in
            let character = layout.characterIndexForGlyph(at: range.location), number = self.lines.number(at: character)
            guard character == self.lines.starts[number - 1] else { return }
            let label = String(number) as NSString, point = self.convert(NSPoint(x: 0, y: line.minY + text.textContainerOrigin.y), from: text)
            label.draw(at: NSPoint(x: self.ruleThickness - label.size(withAttributes: attributes).width - 8, y: point.y + 2), withAttributes: attributes)
            if self.canComment, self.hover == number, let image = NSImage(systemSymbolName: "plus", accessibilityDescription: String(localized: "添加批注", bundle: .module)) {
                image.draw(in: NSRect(x: 4, y: point.y + 2, width: 12, height: 12))
            }
        }
    }
}
private final class FileSourceScroll: NSScrollView {
    var wrapping = true
    weak var annotations: TaskSourceAnnotations?
    override func layout() {
        super.layout()
        guard let text = documentView as? NSTextView, let container = text.textContainer, let layout = text.layoutManager else { return }
        let width = max(1, contentSize.width)
        container.widthTracksTextView = wrapping; container.containerSize = NSSize(width: wrapping ? max(1, width - 20) : CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        layout.ensureLayout(for: container); let used = layout.usedRect(for: container)
        annotations?.position()
        let size = NSSize(width: wrapping ? width : max(width, used.width + 24), height: max(contentSize.height, used.height + 36, annotations?.contentHeight ?? 0))
        if text.frame.size != size { text.setFrameSize(size) }
        verticalRulerView?.needsDisplay = true
    }
}
private final class FileSourceTextView: NSTextView {
    private let fileUndo: UndoManager = { let value = UndoManager(); value.levelsOfUndo = 100; return value }()
    override var undoManager: UndoManager? { fileUndo }
    var canComment = false
    var beginComment: (TaskSourceLineRange) -> Void = { _ in }
    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event)
        if canComment, let menu { menu.addItem(.separator()); let item = NSMenuItem(title: String(localized: "添加批注", bundle: .module), action: #selector(addFileComment), keyEquivalent: ""); item.target = self; menu.addItem(item) }
        return menu
    }
    @objc private func addFileComment() {
        guard canComment else { return }; let range = selectedRange(), lines = TaskSourceLines(string)
        window?.makeFirstResponder(nil); beginComment(TaskSourceLineRange(lines.number(at: range.location), lines.number(at: max(range.location, NSMaxRange(range) - 1))))
        setSelectedRange(NSRange(location: range.location, length: 0))
    }
}

@MainActor fileprivate final class FileSourceState {
    let scroll = FileSourceScroll(), text = FileSourceTextView()
    let annotations = TaskSourceAnnotations()
    var annotationUpdate: (() -> Void)?
    var externalUndo: TaskSourceExternalUndo<TaskSourceUndoSnapshot>?
    var source = "", style: UUID?, loaded = false
    var request: TaskSourceRevealRequest?, origin = CGPoint.zero, pendingOrigin: CGPoint?, pendingLine: Int?
    var pendingCommit: String?
    init() {
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        text.isSelectable = true; text.isRichText = false; text.allowsUndo = true; text.drawsBackground = false
        text.textContainerInset = NSSize(width: 10, height: 12)
        text.isAutomaticQuoteSubstitutionEnabled = false; text.isAutomaticDashSubstitutionEnabled = false
        text.isAutomaticTextReplacementEnabled = false; text.isAutomaticSpellingCorrectionEnabled = false
        text.isVerticallyResizable = true; text.isHorizontallyResizable = true; text.minSize = .zero
        text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        scroll.documentView = text
        annotations.attach(text); scroll.annotations = annotations
        let ruler = FileLineRuler(scrollView: scroll, orientation: .verticalRuler); ruler.clientView = text; ruler.ruleThickness = 58
        scroll.verticalRulerView = ruler; scroll.hasVerticalRuler = true; scroll.rulersVisible = true
        scroll.contentView.postsBoundsChangedNotifications = true
        text.setAccessibilityLabel(String(localized: "源代码", bundle: .module))
    }
    func discard() { text.undoManager?.removeAllActions() }
}

private final class FileSourceHost: NSView {
    var state: FileSourceState?
    override func layout() {
        super.layout()
        guard let state, bounds.width > 0, bounds.height > 0 else { return }
        let scroll = state.scroll; scroll.frame = bounds; state.annotationUpdate?(); scroll.needsLayout = true; scroll.layoutSubtreeIfNeeded()
        if let line = state.pendingLine {
            state.pendingLine = nil; state.pendingOrigin = nil
            let range = TaskSourceLines(state.text.string).range(line: line)
            state.text.setSelectedRange(range); state.text.scrollRangeToVisible(range)
        } else if let origin = state.pendingOrigin {
            state.pendingOrigin = nil
            scroll.contentView.scroll(to: TaskSourceEditorPosition.origin(origin, content: state.text.frame.size, viewport: scroll.contentSize))
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        state.origin = scroll.contentView.bounds.origin
    }
}

private struct TaskSourceNativeView: NSViewRepresentable {
    let source: String; let highlight: CodeHighlight?; let highlightID: UUID?
    let identity: String; let line: Int?; let reveal: Int; let wrapping: Bool
    let editable: Bool; let change: (String) -> Void
    let edited: ((String, Bool, Bool, TaskSourceTextEdit?) -> Void)?
    let annotations: [TaskFileLineAnnotation]; let canComment: Bool
    let beginComment: (TaskSourceLineRange) -> Void; let submitComment: (UUID, String) -> Void; let removeComment: (UUID) -> Void
    let locale: Locale; let dark: Bool
    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var state: FileSourceState?, identity = "", applying = false, detaching = false
        var change: (String) -> Void = { _ in }; var observer: NSObjectProtocol?
        var edited: ((String, Bool, Bool, TaskSourceTextEdit?) -> Void)?
        var pendingEdit: TaskSourceTextEdit?
        func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange, replacementString: String?) -> Bool {
            if !applying, let replacementString { pendingEdit = TaskSourceTextEdit(range: affectedCharRange, replacement: replacementString) }; return true
        }
        func report(_ text: NSTextView) {
            guard let state, state.text === text, !applying, text.isEditable, !text.hasMarkedText(), text.string != state.source else { return }
            let edit = pendingEdit.flatMap { edit in NSMaxRange(edit.range) <= (state.source as NSString).length && (state.source as NSString).replacingCharacters(in: edit.range, with: edit.replacement) == text.string ? edit : nil }; pendingEdit = nil
            state.source = text.string; state.style = nil
            if let ruler = state.scroll.verticalRulerView as? FileLineRuler {
                ruler.lines = TaskSourceLines(text.string); ruler.ruleThickness = max(58, CGFloat(String(ruler.lines.starts.count).count) * 8 + 30)
                ruler.needsDisplay = true; state.scroll.needsLayout = true
            }
            if detaching {
                let callback = change, edit = edited, value = text.string; state.pendingCommit = value
                Task { @MainActor in if let edit { edit(value, false, false, nil) } else { callback(value) }; if state.pendingCommit == value { state.pendingCommit = nil } }
            } else if let edited { edited(text.string, text.undoManager?.isUndoing == true, text.undoManager?.isRedoing == true, edit) }
            else { change(text.string) }
        }
        func textDidChange(_ notification: Notification) { if let text = notification.object as? NSTextView { report(text) } }
        func textViewDidChangeSelection(_ notification: Notification) { if let text = notification.object as? NSTextView { report(text) } }
        func attach(_ host: FileSourceHost, key: String) {
            guard identity != key || state == nil else { return }
            detach(host)
            identity = key
            let value = FileSourceState(); state = value
            if let manager = value.text.undoManager {
                value.externalUndo = TaskSourceExternalUndo(manager: manager, read: { [weak value] in TaskSourceUndoSnapshot(source: value?.text.string ?? "", ranges: value?.text.selectedRanges.map(\.rangeValue) ?? []) }, write: { [weak self, weak value] snapshot in
                    guard let self, let value, self.state === value else { return }
                    let undo = value.text.undoManager, enabled = undo?.isUndoRegistrationEnabled == true
                    if enabled { undo?.disableUndoRegistration() }
                    value.text.textStorage?.setAttributedString(FileSourceText.attributed(snapshot.source, highlight: nil))
                    value.text.selectedRanges = snapshot.ranges.map { NSValue(range: TaskSourceEditorPosition.selection($0, length: (snapshot.source as NSString).length)) }
                    if enabled { undo?.enableUndoRegistration() }
                    self.report(value.text)
                })
            }
            value.pendingOrigin = value.origin; value.text.delegate = self; host.state = value; host.addSubview(value.scroll)
            observer = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: value.scroll.contentView, queue: .main) { [weak value] _ in
                MainActor.assumeIsolated { value?.scroll.verticalRulerView?.needsDisplay = true }
            }
        }
        func detach(_ host: FileSourceHost) {
            guard let state else { return }
            // Commit to the callback captured for the outgoing file before changing identity.
            detaching = true
            if state.text.hasMarkedText() { state.text.unmarkText() }; report(state.text)
            state.text.breakUndoCoalescing()
            if state.text.window?.firstResponder === state.text { state.text.window?.makeFirstResponder(nil) }
            state.origin = state.scroll.contentView.bounds.origin; state.text.delegate = nil
            if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
            state.scroll.removeFromSuperview(); host.state = nil; state.discard()
            self.state = nil; change = { _ in }; edited = nil; pendingEdit = nil; detaching = false
        }
        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> FileSourceHost { FileSourceHost() }
    func updateNSView(_ host: FileSourceHost, context: Context) {
        let saved = context.coordinator; saved.attach(host, key: identity)
        guard let state = saved.state else { return }; let text = state.text, scroll = state.scroll
        saved.change = change; saved.edited = edited; text.isEditable = editable
        text.canComment = canComment; text.beginComment = beginComment
        if let ruler = scroll.verticalRulerView as? FileLineRuler { if ruler.canComment != canComment { ruler.canComment = canComment; ruler.window?.invalidateCursorRects(for: ruler) }; ruler.beginComment = beginComment }
        guard !text.hasMarkedText() else { return }
        let contents = state.pendingCommit ?? source, styleID = contents == source ? highlightID : nil
        if !state.loaded || contents != state.source || state.style != styleID {
            let ranges = text.selectedRanges, origin = state.pendingOrigin ?? scroll.contentView.bounds.origin
            saved.applying = true
            if let storage = text.textStorage {
                let attributes = FileSourceText.attributed(contents, highlight: contents == source ? highlight : nil)
                if state.loaded, editable, text.string != contents {
                    text.breakUndoCoalescing(); text.undoManager?.beginUndoGrouping()
                    state.externalUndo?.replace(.replacement(contents)); text.undoManager?.endUndoGrouping()
                } else if text.string != contents { storage.setAttributedString(attributes); text.undoManager?.removeAllActions() }
                let undo = text.undoManager, enabled = undo?.isUndoRegistrationEnabled == true
                if enabled { undo?.disableUndoRegistration() }; FileSourceText.apply(attributes, to: storage); if enabled { undo?.enableUndoRegistration() }
            }
            text.typingAttributes = FileSourceText.attributed(" ", highlight: nil).attributes(at: 0, effectiveRange: nil)
            if !state.loaded || contents == state.source { text.selectedRanges = ranges.map { NSValue(range: TaskSourceEditorPosition.selection($0.rangeValue, length: (contents as NSString).length)) } }
            state.source = contents; state.style = styleID; state.loaded = true; state.pendingOrigin = origin
            if let ruler = scroll.verticalRulerView as? FileLineRuler { ruler.lines = TaskSourceLines(contents); ruler.ruleThickness = max(58, CGFloat(String(ruler.lines.starts.count).count) * 8 + 30) }
            saved.applying = false
        }
        state.annotationUpdate = { [weak state] in state?.annotations.update(annotations, locale: locale, dark: dark, submit: submitComment, remove: removeComment) }
        scroll.wrapping = wrapping; scroll.hasHorizontalScroller = !wrapping
        let request = TaskSourceRevealRequest(line: line, generation: reveal)
        if request.needsReveal(after: state.request) { state.pendingLine = line; state.pendingOrigin = nil }
        state.request = request; host.needsLayout = true; host.layoutSubtreeIfNeeded()
    }
    static func dismantleNSView(_ host: FileSourceHost, coordinator: Coordinator) { coordinator.detach(host) }
}
#else
private final class FileSourceTextView: UITextView {
    private let fileUndo: UndoManager = { let value = UndoManager(); value.levelsOfUndo = 100; return value }()
    override var undoManager: UndoManager? { fileUndo }
    var canComment = false
    var beginComment: (TaskSourceLineRange) -> Void = { _ in }
    var lines = TaskSourceLines("")
    override func draw(_ rect: CGRect) {
        super.draw(rect)
        let visible = bounds.offsetBy(dx: -textContainerInset.left, dy: -textContainerInset.top)
        let glyphs = layoutManager.glyphRange(forBoundingRect: visible, in: textContainer)
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: UIColor.secondaryLabel]
        layoutManager.enumerateLineFragments(forGlyphRange: glyphs) { line, _, _, range, _ in
            let character = self.layoutManager.characterIndexForGlyph(at: range.location), number = self.lines.number(at: character)
            if character == self.lines.starts[number - 1] { (String(number) as NSString).draw(at: CGPoint(x: self.bounds.minX + 8, y: line.minY + self.textContainerInset.top + 2), withAttributes: attributes) }
        }
    }
}

@MainActor fileprivate final class FileSourceState {
    let text = FileSourceTextView()
    let annotations = TaskSourceAnnotations()
    var annotationUpdate: (() -> Void)?
    var externalUndo: TaskSourceExternalUndo<TaskSourceUndoSnapshot>?
    var source = "", style: UUID?, loaded = false, wrapping = true
    var request: TaskSourceRevealRequest?, origin = CGPoint.zero, pendingOrigin: CGPoint?, pendingLine: Int?
    var pendingCommit: String?
    init() {
        text.isSelectable = true; text.backgroundColor = .clear; text.contentInsetAdjustmentBehavior = .never
        text.autocapitalizationType = .none; text.autocorrectionType = .no; text.smartQuotesType = .no; text.smartDashesType = .no
        text.textContainerInset = UIEdgeInsets(top: 12, left: 48, bottom: 12, right: 12)
        text.accessibilityLabel = String(localized: "源代码", bundle: .module)
        annotations.attach(text)
    }
    func discard() { text.undoManager?.removeAllActions() }
}

private final class FileSourceHost: UIView {
    var state: FileSourceState?
    override func layoutSubviews() {
        super.layoutSubviews()
        guard let state, bounds.width > 0, bounds.height > 0 else { return }
        let view = state.text; view.frame = bounds
        view.textContainer.widthTracksTextView = state.wrapping
        view.textContainer.size.width = state.wrapping ? max(1, bounds.width - 60) : CGFloat.greatestFiniteMagnitude
        state.annotationUpdate?(); view.layoutManager.ensureLayout(for: view.textContainer); view.layoutIfNeeded(); state.annotations.position()
        if state.annotations.contentHeight > view.contentSize.height { view.contentSize.height = state.annotations.contentHeight }
        if let line = state.pendingLine {
            state.pendingLine = nil; state.pendingOrigin = nil
            let range = TaskSourceLines(view.text).range(line: line); view.selectedRange = range; view.scrollRangeToVisible(range)
        } else if let origin = state.pendingOrigin {
            state.pendingOrigin = nil
            view.setContentOffset(TaskSourceEditorPosition.origin(origin, content: view.contentSize, viewport: view.bounds.size), animated: false)
        }
        state.origin = view.contentOffset
    }
}

private struct TaskSourceNativeView: UIViewRepresentable {
    let source: String; let highlight: CodeHighlight?; let highlightID: UUID?
    let identity: String; let line: Int?; let reveal: Int; let wrapping: Bool
    let editable: Bool; let change: (String) -> Void
    let edited: ((String, Bool, Bool, TaskSourceTextEdit?) -> Void)?
    let annotations: [TaskFileLineAnnotation]; let canComment: Bool
    let beginComment: (TaskSourceLineRange) -> Void; let submitComment: (UUID, String) -> Void; let removeComment: (UUID) -> Void
    let locale: Locale; let dark: Bool
    @MainActor final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        var state: FileSourceState?, identity = "", applying = false, detaching = false
        var change: (String) -> Void = { _ in }
        var edited: ((String, Bool, Bool, TaskSourceTextEdit?) -> Void)?
        var pendingEdit: TaskSourceTextEdit?
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            if !applying { pendingEdit = TaskSourceTextEdit(range: range, replacement: text) }; return true
        }
        private var gutterAnchor: Int?
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard let text = state?.text, text.canComment else { return false }; return touch.location(in: text).x < text.textContainerInset.left
        }
        private func gutterLine(_ gesture: UIGestureRecognizer, text: UITextView) -> Int {
            var point = gesture.location(in: text); point.x = 0; point.y -= text.textContainerInset.top
            return TaskSourceLines(text.text).number(at: text.layoutManager.characterIndex(for: point, in: text.textContainer, fractionOfDistanceBetweenInsertionPoints: nil))
        }
        @objc private func tapGutter(_ gesture: UITapGestureRecognizer) {
            guard let text = state?.text, text.canComment, gesture.state == .ended else { return }
            let number = gutterLine(gesture, text: text); text.resignFirstResponder(); text.selectedRange.length = 0; text.beginComment(TaskSourceLineRange(number, number))
        }
        @objc private func dragGutter(_ gesture: UIPanGestureRecognizer) {
            guard let text = state?.text, text.canComment else { gutterAnchor = nil; return }
            let line = gutterLine(gesture, text: text)
            if gesture.state == .began { gutterAnchor = line }
            guard let anchor = gutterAnchor else { return }
            let range = TaskSourceLineRange(anchor, line), lines = TaskSourceLines(text.text), first = lines.range(line: range.start), last = lines.range(line: range.end)
            if gesture.state == .changed { text.selectedRange = NSRange(location: first.location, length: NSMaxRange(last) - first.location) }
            if gesture.state == .ended { gutterAnchor = nil; text.resignFirstResponder(); text.selectedRange.length = 0; text.beginComment(range) }
            else if gesture.state == .cancelled || gesture.state == .failed { gutterAnchor = nil }
        }
        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard let text = state?.text, text === textView, text.canComment else { return UIMenu(children: suggestedActions) }
            let action = UIAction(title: String(localized: "添加批注", bundle: .module), image: UIImage(systemName: "text.bubble")) { [weak self, weak text] _ in
                guard let self, let text, self.state?.text === text, text.canComment else { return }
                let lines = TaskSourceLines(text.text); text.resignFirstResponder(); text.selectedRange.length = 0
                text.beginComment(TaskSourceLineRange(lines.number(at: range.location), lines.number(at: max(range.location, NSMaxRange(range) - 1))))
            }
            return UIMenu(children: suggestedActions + [action])
        }
        func report(_ view: UITextView) {
            guard let state, state.text === view, !applying, view.isEditable, view.markedTextRange == nil, view.text != state.source else { return }
            let edit = pendingEdit.flatMap { edit in NSMaxRange(edit.range) <= (state.source as NSString).length && (state.source as NSString).replacingCharacters(in: edit.range, with: edit.replacement) == view.text ? edit : nil }; pendingEdit = nil
            state.source = view.text; state.style = nil; state.text.lines = TaskSourceLines(view.text); view.setNeedsDisplay()
            if detaching {
                let callback = change, edit = edited, value = state.source; state.pendingCommit = value
                Task { @MainActor in if let edit { edit(value, false, false, nil) } else { callback(value) }; if state.pendingCommit == value { state.pendingCommit = nil } }
            } else if let edited { edited(state.source, view.undoManager?.isUndoing == true, view.undoManager?.isRedoing == true, edit) }
            else { change(state.source) }
        }
        func textViewDidChange(_ textView: UITextView) { report(textView) }
        func textViewDidChangeSelection(_ textView: UITextView) { report(textView) }
        func scrollViewDidScroll(_ scrollView: UIScrollView) { scrollView.setNeedsDisplay() }
        func attach(_ host: FileSourceHost, key: String) {
            guard identity != key || state == nil else { return }
            detach(host); identity = key
            let value = FileSourceState(); state = value
            let tap = UITapGestureRecognizer(target: self, action: #selector(tapGutter)), drag = UIPanGestureRecognizer(target: self, action: #selector(dragGutter))
            tap.delegate = self; drag.delegate = self; tap.require(toFail: drag); value.text.panGestureRecognizer.require(toFail: drag); value.text.addGestureRecognizer(tap); value.text.addGestureRecognizer(drag)
            if let manager = value.text.undoManager {
                value.externalUndo = TaskSourceExternalUndo(manager: manager, read: { [weak value] in TaskSourceUndoSnapshot(source: value?.text.text ?? "", ranges: [value?.text.selectedRange ?? NSRange(location: 0, length: 0)]) }, write: { [weak self, weak value] snapshot in
                    guard let self, let value, self.state === value else { return }
                    let undo = value.text.undoManager, enabled = undo?.isUndoRegistrationEnabled == true
                    if enabled { undo?.disableUndoRegistration() }
                    value.text.textStorage.setAttributedString(FileSourceText.attributed(snapshot.source, highlight: nil))
                    value.text.selectedRange = TaskSourceEditorPosition.selection(snapshot.ranges.first ?? NSRange(location: 0, length: 0), length: (snapshot.source as NSString).length)
                    if enabled { undo?.enableUndoRegistration() }; self.report(value.text)
                })
            }
            value.pendingOrigin = value.origin; value.text.delegate = self; host.state = value; host.addSubview(value.text)
        }
        func detach(_ host: FileSourceHost) {
            guard let state else { return }
            detaching = true
            if state.text.markedTextRange != nil { state.text.unmarkText() }; report(state.text)
            state.text.resignFirstResponder(); state.origin = state.text.contentOffset; state.text.delegate = nil
            state.text.removeFromSuperview(); host.state = nil; state.discard()
            self.state = nil; change = { _ in }; edited = nil; pendingEdit = nil; detaching = false
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> FileSourceHost { FileSourceHost() }
    func updateUIView(_ host: FileSourceHost, context: Context) {
        let saved = context.coordinator; saved.attach(host, key: identity)
        guard let state = saved.state else { return }; let view = state.text
        saved.change = change; saved.edited = edited; view.isEditable = editable
        view.canComment = canComment; view.beginComment = beginComment
        guard view.markedTextRange == nil else { return }
        let contents = state.pendingCommit ?? source, styleID = contents == source ? highlightID : nil
        if !state.loaded || contents != state.source || state.style != styleID {
            let range = view.selectedRange, origin = state.pendingOrigin ?? view.contentOffset
            saved.applying = true
            let attributes = FileSourceText.attributed(contents, highlight: contents == source ? highlight : nil)
            if state.loaded, editable, view.text != contents {
                view.undoManager?.beginUndoGrouping(); state.externalUndo?.replace(.replacement(contents)); view.undoManager?.endUndoGrouping()
            } else if view.text != contents { view.textStorage.setAttributedString(attributes); view.undoManager?.removeAllActions() }
            let undo = view.undoManager, enabled = undo?.isUndoRegistrationEnabled == true
            if enabled { undo?.disableUndoRegistration() }; FileSourceText.apply(attributes, to: view.textStorage); if enabled { undo?.enableUndoRegistration() }
            view.typingAttributes = FileSourceText.attributed(" ", highlight: nil).attributes(at: 0, effectiveRange: nil)
            view.lines = TaskSourceLines(contents)
            if !state.loaded || contents == state.source { view.selectedRange = TaskSourceEditorPosition.selection(range, length: (contents as NSString).length) }
            state.source = contents; state.style = styleID; state.loaded = true; state.pendingOrigin = origin
            saved.applying = false
        }
        state.annotationUpdate = { [weak state] in state?.annotations.update(annotations, locale: locale, dark: dark, submit: submitComment, remove: removeComment) }
        state.wrapping = wrapping; view.alwaysBounceHorizontal = !wrapping; view.setNeedsDisplay()
        let request = TaskSourceRevealRequest(line: line, generation: reveal)
        if request.needsReveal(after: state.request) { state.pendingLine = line; state.pendingOrigin = nil }
        state.request = request; host.setNeedsLayout(); host.layoutIfNeeded()
    }
    static func dismantleUIView(_ host: FileSourceHost, coordinator: Coordinator) { coordinator.detach(host) }
}
#endif
