import SwiftUI
#if os(macOS)
import AppKit

struct TaskCitationSelectionOverlay: NSViewRepresentable {
    let model: TaskCitationSelectionModel
    @Environment(\.openURL) private var openURL
    @Environment(\.taskFileMentionBridge) private var bridge
    func makeNSView(context: Context) -> CitationSelectionView { CitationSelectionView(model: model) }
    func updateNSView(_ view: CitationSelectionView, context: Context) { view.openLink = { openURL($0) }; view.composer = { bridge?.context?.citations }; view.model = model;view.window?.invalidateCursorRects(for:view) }
    static func dismantleNSView(_ view: CitationSelectionView, coordinator: ()) { view.stopObserving() }
}

final class CitationSelectionView: NSView {
    var model: TaskCitationSelectionModel
    var openLink: ((URL) -> Void)?
    private var anchor = 0
    private var down = CGPoint.zero
    private var dragged = false
    private var monitors: [Any] = []
    private var scrollObserver: NSObjectProtocol?
    let citationPopover = TaskCitationPopover()
    init(model: TaskCitationSelectionModel) { self.model = model; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { model.hit(convert(point, from: superview), in: self) == nil ? nil : self }
    override func resetCursorRects() {
        addCursorRect(bounds,cursor:.iBeam)
        for entry in model.entries { for rect in entry.part.linkRectangles() { let clipped=entry.part.citationView.convert(rect,to:self).intersection(bounds);if !clipped.isEmpty { addCursorRect(clipped,cursor:.pointingHand) } } }
    }
    override func viewDidMoveToWindow() {
        stopObserving()
        guard window != nil else { return }
        if let monitor=NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown,handler:{ [weak self] event in
            guard let self, event.window === self.window else { return event }
            let point = self.convert(event.locationInWindow, from: nil)
            let nearAction=self.model.actionVisible && abs(point.x-self.model.actionPoint.x)<90 && abs(point.y-self.model.actionPoint.y)<65
            if !self.bounds.contains(point) && !nearAction && !self.citationPopover.shown { self.model.dismiss() }
            return event
        }) { monitors.append(monitor) }
        if let clip = enclosingScrollView?.contentView {
            scrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in MainActor.assumeIsolated { if self?.dragged != true && self?.model.revealing != true { self?.model.dismiss() } } }
        }
        model.cite = { [weak self] in self?.quoteSelection() }
    }
    func stopObserving() { for monitor in monitors { NSEvent.removeMonitor(monitor) }; monitors = []; if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) }; scrollObserver = nil; citationPopover.close() }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self); down = convert(event.locationInWindow, from: nil); dragged = false
        let offset = model.closest(down, in: self)
        if event.modifierFlags.contains(.shift), let selected = model.selected { anchor = selected.location; model.select(NSRange(location: min(anchor, offset), length: abs(anchor-offset))) }
        else if event.clickCount >= 2 {
            let text = model.text as NSString, point = min(offset, max(0, text.length-1))
            let range = event.clickCount >= 3 ? text.paragraphRange(for: NSRange(location: point, length: 0)) : TaskCitationTextBoundary.word(in:model.text,at:point)
            anchor = range.location; model.select(range)
        } else { anchor = offset; model.select(nil) }
    }
    override func mouseDragged(with event: NSEvent) {
        dragged = true; let point = convert(event.locationInWindow, from: nil), offset = model.closest(point, in: self)
        model.select(NSRange(location: min(anchor, offset), length: abs(anchor-offset))); autoscroll(with: event)
    }
    override func mouseUp(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if !dragged, event.clickCount == 1, !event.modifierFlags.contains(.shift), let link = model.link(model.closest(point, in: self)) { openLink?(link) }
        dragged = false; model.finish(at: point, clicks: event.clickCount)
    }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { model.dismiss(); return }
        if event.keyCode == 48, model.actionVisible { model.focusAction?(); return }
        super.keyDown(with: event)
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "c", model.selected != nil { copy(nil); return true }
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "a" { selectAll(nil); return true }
        return super.performKeyEquivalent(with: event)
    }
    @objc func copy(_ sender: Any?) { if let range = model.selected { copyAgentText((model.text as NSString).substring(with: range)) } }
    override func selectAll(_ sender: Any?) { model.select(NSRange(location: 0, length: model.text.utf16.count)); model.finish(at: .zero) }
    @objc private func citeSelection(_ sender: Any?) { model.quote() }
    override func menu(for event: NSEvent) -> NSMenu? {
        guard model.selected != nil else { return nil }; let menu = NSMenu()
        for (title, action) in [("复制", #selector(copy(_:))), ("引用", #selector(citeSelection(_:))), ("全选", #selector(selectAll(_:)))] {
            let item = NSMenuItem(title: String(localized:String.LocalizationValue(title),bundle:.module), action: action, keyEquivalent: ""); item.target = self
            item.isEnabled = action != #selector(citeSelection(_:)) || model.canCite && model.citation != nil; menu.addItem(item)
        }; menu.autoenablesItems = false; return menu
    }
    var composer: (() -> TaskCitationComposer?)?
    private func quoteSelection() {
        guard let citation = model.citation, let broker = composer?(), broker.enabled, let target = broker.insert(citation) else { return }
        let rect = model.selected.flatMap { model.rectangles($0, in: self).last } ?? CGRect(origin: model.actionPoint, size: CGSize(width: 1, height: 20))
        citationPopover.show(target: target, composer: broker, anchor: self, rect: rect)
    }
}
#else
import UIKit

struct TaskCitationSelectionOverlay: UIViewRepresentable {
    let model: TaskCitationSelectionModel
    @Environment(\.openURL) private var openURL
    @Environment(\.taskFileMentionBridge) private var bridge
    func makeUIView(context: Context) -> CitationSelectionView { CitationSelectionView(model: model) }
    func updateUIView(_ view: CitationSelectionView, context: Context) { view.openLink = { openURL($0) }; view.composer = { bridge?.context?.citations }; view.model = model }
    static func dismantleUIView(_ view: CitationSelectionView, coordinator: ()) { view.citationPopover.close() }
}
private final class CitationPosition: UITextPosition { let offset: Int; init(_ offset: Int) { self.offset = offset } }
private final class CitationRange: UITextRange {
    let value: NSRange
    init(_ value: NSRange) { self.value = value }
    override var start: UITextPosition { CitationPosition(value.location) }
    override var end: UITextPosition { CitationPosition(NSMaxRange(value)) }
    override var isEmpty: Bool { value.length == 0 }
}
private final class CitationSelectionRect: UITextSelectionRect {
    let value: CGRect; let first: Bool; let last: Bool
    init(_ value: CGRect, first: Bool, last: Bool) { self.value=value; self.first=first; self.last=last }
    override var rect: CGRect { value }
    override var writingDirection: NSWritingDirection { .natural }
    override var containsStart: Bool { first }
    override var containsEnd: Bool { last }
    override var isVertical: Bool { false }
}
final class CitationSelectionView: UIView, UITextInput, UITextInteractionDelegate {
    var model: TaskCitationSelectionModel
    var openLink: ((URL) -> Void)?
    var composer: (() -> TaskCitationComposer?)?
    let citationPopover = TaskCitationPopover()
    weak var inputDelegate: (any UITextInputDelegate)?
    lazy var tokenizer: any UITextInputTokenizer = UITextInputStringTokenizer(textInput: self)
    var markedTextStyle: [NSAttributedString.Key: Any]?
    var markedTextRange: UITextRange? { nil }
    var selectedTextRange: UITextRange? {
        get { model.selected.map(CitationRange.init) }
        set { inputDelegate?.selectionWillChange(self); model.select((newValue as? CitationRange)?.value); inputDelegate?.selectionDidChange(self) }
    }
    var beginningOfDocument: UITextPosition { CitationPosition(0) }
    var endOfDocument: UITextPosition { CitationPosition(model.text.utf16.count) }
    var hasText: Bool { !model.text.isEmpty }
    var textInputView: UIView { self }
    private let keyboardSuppressionView=UIView(frame:.zero)
    override var inputView:UIView? { keyboardSuppressionView }
    private var scrollObservation:NSKeyValueObservation?
    private var interacting=false
    override var canBecomeFirstResponder: Bool { true }
    init(model: TaskCitationSelectionModel) {
        self.model = model; super.init(frame: .zero); backgroundColor = .clear
        let interaction = UITextInteraction(for: .nonEditable); interaction.textInput = self; interaction.delegate = self; addInteraction(interaction)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:))); tap.cancelsTouchesInView = false; addGestureRecognizer(tap)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func didMoveToWindow() {
        super.didMoveToWindow();model.cite={ [weak self] in self?.quoteSelection() };scrollObservation=nil
        var parent=superview
        while let current=parent {
            if let scroll=current as? UIScrollView { scrollObservation=scroll.observe(\.contentOffset,options:[.new]) { [weak self] _,_ in MainActor.assumeIsolated { if self?.interacting != true && self?.model.revealing != true { self?.model.dismiss() } } };break };parent=current.superview
        }
    }
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool { model.hit(point, in: self) != nil }
    func interactionShouldBegin(_ interaction: UITextInteraction, at point: CGPoint) -> Bool { model.hit(point, in: self) != nil }
    func interactionWillBegin(_ interaction:UITextInteraction) { interacting=true }
    func interactionDidEnd(_ interaction: UITextInteraction) {
        interacting=false
        guard let range = model.selected else { return }; let rect = model.rectangles(range, in: self).last ?? .zero
        model.finish(at: CGPoint(x: rect.midX, y: rect.maxY))
    }
    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        if model.selected == nil, let link = model.link(model.closest(point, in: self)) { openLink?(link) }
    }
    func text(in range: UITextRange) -> String? { guard let range = range as? CitationRange else { return nil }; return (model.text as NSString).substring(with: TaskSourceEditorPosition.selection(range.value, length: model.text.utf16.count)) }
    func replace(_ range: UITextRange, withText text: String) {}
    func setMarkedText(_ markedText: String?, selectedRange: NSRange) {}
    func unmarkText() {}
    func insertText(_ text: String) {}
    func deleteBackward() {}
    func textRange(from fromPosition: UITextPosition, to toPosition: UITextPosition) -> UITextRange? { let a = index(fromPosition), b = index(toPosition); return CitationRange(NSRange(location: min(a,b), length: abs(b-a))) }
    func position(from position: UITextPosition, offset: Int) -> UITextPosition? { let value=index(position)+offset; return value >= 0 && value <= model.text.utf16.count ? CitationPosition(value) : nil }
    func position(from position: UITextPosition, in direction: UITextLayoutDirection, offset: Int) -> UITextPosition? { self.position(from: position, offset: direction == .left || direction == .up ? -offset : offset) }
    func compare(_ position: UITextPosition, to other: UITextPosition) -> ComparisonResult { index(position) == index(other) ? .orderedSame : index(position) < index(other) ? .orderedAscending : .orderedDescending }
    func offset(from: UITextPosition, to toPosition: UITextPosition) -> Int { index(toPosition)-index(from) }
    func position(within range: UITextRange, farthestIn direction: UITextLayoutDirection) -> UITextPosition? { direction == .left || direction == .up ? range.start : range.end }
    func characterRange(byExtending position: UITextPosition, in direction: UITextLayoutDirection) -> UITextRange? { guard let end = self.position(from: position, in: direction, offset: 1) else { return nil }; return textRange(from: position, to: end) }
    func baseWritingDirection(for position: UITextPosition, in direction: UITextStorageDirection) -> NSWritingDirection { .natural }
    func setBaseWritingDirection(_ writingDirection: NSWritingDirection, for range: UITextRange) {}
    func firstRect(for range: UITextRange) -> CGRect { (range as? CitationRange).flatMap { model.rectangles($0.value, in: self).first } ?? .zero }
    func caretRect(for position: UITextPosition) -> CGRect {
        let offset = min(index(position), max(0, model.text.utf16.count-1)); var rect = model.rectangles(NSRange(location: offset, length: model.text.isEmpty ? 0 : 1), in: self).first ?? .zero; rect.size.width=2; return rect
    }
    func selectionRects(for range: UITextRange) -> [UITextSelectionRect] { guard let range=range as? CitationRange else { return [] }; let rects=model.rectangles(range.value, in: self); return rects.enumerated().map { CitationSelectionRect($0.element, first: $0.offset == 0, last: $0.offset == rects.count-1) } }
    func closestPosition(to point: CGPoint) -> UITextPosition? { CitationPosition(model.closest(point, in: self)) }
    func closestPosition(to point: CGPoint, within range: UITextRange) -> UITextPosition? { guard let range=range as? CitationRange else { return nil }; return CitationPosition(min(NSMaxRange(range.value), max(range.value.location, model.closest(point, in: self)))) }
    func characterRange(at point: CGPoint) -> UITextRange? { let i=model.closest(point, in:self); return CitationRange(NSRange(location:i,length:i<model.text.utf16.count ? 1:0)) }
    private func index(_ position: UITextPosition) -> Int { min(model.text.utf16.count, max(0,(position as? CitationPosition)?.offset ?? 0)) }
    override func copy(_ sender: Any?) { if let range=model.selected { copyAgentText((model.text as NSString).substring(with: range)) } }
    override func selectAll(_ sender: Any?) { selectedTextRange=CitationRange(NSRange(location:0,length:model.text.utf16.count)) }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool { action == #selector(copy(_:)) && model.selected != nil || action == #selector(selectAll(_:)) }
    private func quoteSelection() {
        guard let citation=model.citation, let broker=composer?(), broker.enabled, let target=broker.insert(citation) else { return }
        citationPopover.show(target:target,composer:broker,anchor:self,rect:model.selected.flatMap { model.rectangles($0,in:self).last } ?? .zero)
    }
}
#endif
