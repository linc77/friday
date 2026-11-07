import SwiftUI
#if os(macOS)
import AppKit
private typealias DiffColor = NSColor
private typealias DiffFont = NSFont
#else
import UIKit
private typealias DiffColor = UIColor
private typealias DiffFont = UIFont
#endif

struct TaskDiffCodeView: View {
    let patch: String; let split: Bool; let identity: String
    var comments: [TaskDiffInlineComment] = []
    var canComment = false
    var beginComment: (TaskDiffReviewSelection) -> Void = { _ in }
    var submitComment: (UUID, String) -> Void = { _, _ in }
    var removeComment: (UUID) -> Void = { _ in }
    var customComment: ((String) -> AnyView?)? = nil
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.locale) private var locale
    var body: some View {
        NativeTaskDiffView(input: TaskDiffNativeInput(patch: patch, split: split, identity: identity, dark: scheme == .dark,
            contrast: contrast == .increased, locale: locale, comments: comments, canComment: canComment,
            begin: beginComment, submit: submitComment, remove: removeComment, content: customComment))
    }
}
struct TaskDiffNativeInput {
    let patch: String; let split: Bool; let identity: String; let dark: Bool; let contrast: Bool; let locale: Locale
    let comments: [TaskDiffInlineComment]; let canComment: Bool
    let begin: (TaskDiffReviewSelection) -> Void; let submit: (UUID, String) -> Void; let remove: (UUID) -> Void
    var content: ((String) -> AnyView?)? = nil
    var theme: String { "\(dark)|\(contrast)|\(locale.identifier)" }
}

@MainActor private enum DiffPresentation {
    static var font: DiffFont { DiffFont.monospacedSystemFont(ofSize: 12, weight: .regular) }
    static var unit: CGFloat { ("0" as NSString).size(withAttributes: [.font: font]).width }
    static func text(_ document: TaskDiffRenderedDocument, contrast: Bool) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle(); paragraph.minimumLineHeight = 20; paragraph.maximumLineHeight = 20; paragraph.lineBreakMode = .byClipping
        #if os(macOS)
        let foreground = NSColor.textColor, secondary = NSColor.secondaryLabelColor
        #else
        let foreground = UIColor.label, secondary = UIColor.secondaryLabel
        #endif
        let result = NSMutableAttributedString(string: document.text, attributes: [.font: font, .foregroundColor: foreground, .paragraphStyle: paragraph])
        for row in document.rows {
            if let color = background(row.line?.kind, contrast: contrast) { result.addAttribute(.backgroundColor, value: color, range: row.range) }
            if let source = row.source { result.addAttribute(.foregroundColor, value: secondary, range: NSRange(location: row.range.location, length: source.location - row.range.location)) }
            else { result.addAttribute(.foregroundColor, value: secondary, range: row.range) }
        }
        return result
    }
    static func background(_ kind: TaskDiffDocument.Kind?, contrast: Bool) -> DiffColor? {
        switch kind {
        case .addition: return DiffColor.systemGreen.withAlphaComponent(contrast ? 0.25 : 0.12)
        case .deletion: return DiffColor.systemRed.withAlphaComponent(contrast ? 0.25 : 0.12)
        case .hunk: return DiffColor.systemBlue.withAlphaComponent(contrast ? 0.2 : 0.08)
        default: return nil
        }
    }
    static func annotations(_ values: [TaskDiffInlineComment], document: TaskDiffRenderedDocument) -> [TaskFileLineAnnotation] {
        values.compactMap { value in
            guard let row = document.anchor(value.selection.last) else { return nil }
            return TaskFileLineAnnotation(id: value.id, range: TaskSourceLineRange(row.displayLine, row.displayLine), text: value.text, presentationID: value.presentationID, presentationVersion: value.presentationVersion)
        }
    }
    static func pair(_ layouts: [TaskSourceAnnotations], documents: [TaskDiffRenderedDocument]) {
        var heights: [Int: CGFloat] = [:]
        for (index, document) in documents.enumerated() {
            for row in document.rows { heights[row.slot] = max(heights[row.slot] ?? 0, layouts[index].reservedHeights[row.displayLine] ?? 0) }
        }
        for (index, document) in documents.enumerated() {
            var mapped: [Int: CGFloat] = [:]
            for row in document.rows { if let height = heights[row.slot], height > 0 { mapped[row.displayLine] = height } }
            layouts[index].reserve(mapped)
        }
    }
    static func selectedRows(_ document: TaskDiffRenderedDocument, patch: String, selection: TaskDiffReviewSelection) -> [NSRange] {
        let review = TaskDiffReviewDocument(patch)
        guard let first = review.index(selection.first), let last = review.index(selection.last) else { return [] }
        let ids = Set(review.rows[min(first,last)...max(first,last)].map(\.id))
        return document.rows.compactMap { row in row.line.flatMap { ids.contains($0.id) ? row.source : nil } }
    }
    static func rowRect(_ row: TaskDiffRenderedDocument.Row, layout: NSLayoutManager, origin: CGPoint) -> CGRect {
        let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: row.range.location, length: 1), actualCharacterRange: nil)
        return layout.lineFragmentUsedRect(forGlyphAt: glyphs.location, effectiveRange: nil).offsetBy(dx: origin.x, dy: origin.y)
    }
}

#if os(macOS)
private struct NativeTaskDiffView: NSViewRepresentable {
    let input: TaskDiffNativeInput
    func makeNSView(context: Context) -> TaskDiffHostView { TaskDiffHostView() }
    func updateNSView(_ view: TaskDiffHostView, context: Context) { view.update(input) }
}
private final class TaskDiffTextView: NSTextView {
    var document = TaskDiffRenderedDocument(patch: "", side: nil)
    let annotations = TaskSourceAnnotations()
    var canComment = false, contrast = false
    var begin: (TaskDiffReviewSelection) -> Void = { _ in }
    var hit: (CGPoint) -> TaskDiffReviewPoint? = { _ in nil }
    var highlight: (TaskDiffReviewSelection) -> Void = { _ in }
    private var anchor: TaskDiffReviewPoint?, endpoint: TaskDiffReviewPoint?
    private var tracking: NSTrackingArea?, hover: Int?
    func cancelGutterSelection() { anchor = nil; endpoint = nil; hover = nil }
    var gutterWidth: CGFloat { CGFloat(document.gutterCharacters) * DiffPresentation.unit + textContainerOrigin.x }
    override func copy(_ sender: Any?) {
        let value = document.copied(selectedRanges.map(\.rangeValue))
        if !value.isEmpty { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(value, forType: .string) }
    }
    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event)
        if canComment, document.selection(nonEmptySelection) != nil, let menu {
            menu.addItem(.separator()); let item = NSMenuItem(title: String(localized: "添加批注", bundle: .module), action: #selector(addReview), keyEquivalent: ""); item.target = self; menu.addItem(item)
        }
        return menu
    }
    private var nonEmptySelection: NSRange { let value = selectedRange(); return NSRange(location: value.location, length: max(1,value.length)) }
    @objc private func addReview() {
        guard canComment, let range = document.selection(nonEmptySelection) else { return }
        window?.makeFirstResponder(nil); setSelectedRange(NSRange(location: selectedRange().location, length: 0)); begin(range)
    }
    func point(_ windowPoint: CGPoint) -> TaskDiffReviewPoint? {
        guard let layoutManager, let textContainer else { return nil }
        let local = convert(windowPoint, from: nil), y = min(max(local.y, visibleRect.minY), max(visibleRect.minY, visibleRect.maxY - 1))
        let offset = layoutManager.characterIndex(for: CGPoint(x: 0, y: y - textContainerOrigin.y), in: textContainer, fractionOfDistanceBetweenInsertionPoints: nil)
        let side = document.side ?? (local.x - visibleRect.minX < textContainerOrigin.x + CGFloat(document.numberCharacters + 1) * DiffPresentation.unit ? "deletions" : "additions")
        return document.row(at: offset)?.point(side: side)
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas(); if let tracking { removeTrackingArea(tracking) }
        let value = NSTrackingArea(rect: .zero, options: [.mouseMoved,.mouseEnteredAndExited,.activeInKeyWindow,.inVisibleRect], owner: self); addTrackingArea(value); tracking = value
    }
    override func mouseMoved(with event: NSEvent) { let point = convert(event.locationInWindow, from: nil); hover = canComment && point.x - visibleRect.minX < gutterWidth ? self.point(event.locationInWindow).flatMap { document.anchor($0)?.slot } : nil; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hover = nil; needsDisplay = true }
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard canComment, point.x - visibleRect.minX < gutterWidth, let first = self.point(event.locationInWindow) else { super.mouseDown(with: event); return }
        anchor = first; endpoint = first; window?.makeFirstResponder(self); highlight(TaskDiffReviewSelection(start:first.line,side:first.side,end:first.line,endSide:first.side))
    }
    override func mouseDragged(with event: NSEvent) {
        guard let anchor else { super.mouseDragged(with: event); return }
        autoscroll(with: event)
        if let last = hit(event.locationInWindow) ?? point(event.locationInWindow) { endpoint = last; highlight(TaskDiffReviewSelection(start:anchor.line,side:anchor.side,end:last.line,endSide:last.side)) }
    }
    override func mouseUp(with event: NSEvent) {
        guard let anchor, let endpoint else { super.mouseUp(with: event); return }; self.anchor = nil; self.endpoint = nil
        window?.makeFirstResponder(nil); setSelectedRange(NSRange(location: selectedRange().location,length:0)); begin(TaskDiffReviewSelection(start:anchor.line,side:anchor.side,end:endpoint.line,endSide:endpoint.side))
    }
    override func resetCursorRects() {
        super.resetCursorRects(); guard canComment, let layoutManager, let textContainer else { return }
        let glyphs = layoutManager.glyphRange(forBoundingRect: visibleRect.offsetBy(dx:-textContainerOrigin.x,dy:-textContainerOrigin.y), in:textContainer)
        let chars = layoutManager.characterRange(forGlyphRange:glyphs,actualGlyphRange:nil)
        for row in document.visibleRows(chars) where row.point(side:document.side) != nil {
            let rect = DiffPresentation.rowRect(row,layout:layoutManager,origin:textContainerOrigin)
            addCursorRect(CGRect(x:visibleRect.minX,y:rect.minY,width:gutterWidth,height:20),cursor:.pointingHand)
        }
    }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect); guard let layoutManager, let textContainer else { return }
        let visible = visibleRect, x = visible.minX; NSColor.textBackgroundColor.setFill(); NSRect(x:x,y:visible.minY,width:gutterWidth,height:visible.height).fill()
        let glyphs = layoutManager.glyphRange(forBoundingRect:visible.offsetBy(dx:-textContainerOrigin.x,dy:-textContainerOrigin.y),in:textContainer)
        let chars = layoutManager.characterRange(forGlyphRange:glyphs,actualGlyphRange:nil)
        for row in document.visibleRows(chars) {
            let rect = DiffPresentation.rowRect(row,layout:layoutManager,origin:textContainerOrigin)
            if let color = DiffPresentation.background(row.line?.kind,contrast:contrast) { color.setFill(); NSRect(x:x,y:rect.minY,width:gutterWidth,height:20).fill() }
            let prefix = (document.text as NSString).substring(with:NSRange(location:row.range.location,length:(row.source?.location ?? row.range.location) - row.range.location))
            (prefix as NSString).draw(at:CGPoint(x:x+textContainerOrigin.x,y:rect.minY+2),withAttributes:[.font:DiffPresentation.font,.foregroundColor:NSColor.secondaryLabelColor])
            if canComment, hover == row.slot { NSImage(systemSymbolName:"plus",accessibilityDescription:nil)?.draw(in:NSRect(x:x+1,y:rect.minY+3,width:10,height:10)) }
        }
    }
}
@MainActor final class TaskDiffHostView: NSView {
    private let stack = NSStackView()
    private var scrolls: [NSScrollView] = [], views: [TaskDiffTextView] = [], observers: [NSObjectProtocol] = []
    private var input: TaskDiffNativeInput?, signature = "", patch: String?, synchronizing = false
    override init(frame:NSRect) {
        super.init(frame:frame); stack.orientation = .horizontal; stack.distribution = .fillEqually; stack.spacing = 1; stack.translatesAutoresizingMaskIntoConstraints = false; addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:leadingAnchor),stack.trailingAnchor.constraint(equalTo:trailingAnchor),stack.topAnchor.constraint(equalTo:topAnchor),stack.bottomAnchor.constraint(equalTo:bottomAnchor)])
    }
    required init?(coder:NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }
    func update(_ value:TaskDiffNativeInput) {
        let next = value.identity + value.theme + String(value.split), changed = signature != next || patch != value.patch
        let origins = input?.identity == value.identity ? scrolls.map { $0.contentView.bounds.origin } : []
        input = value
        if views.count != (value.split ? 2 : 1) { configure(value.split) }
        if changed {
            for (index, text) in views.enumerated() {
                text.cancelGutterSelection()
                text.document = TaskDiffRenderedDocument(patch:value.patch,side:value.split ? (index == 0 ? "deletions" : "additions") : nil)
                text.textStorage?.setAttributedString(DiffPresentation.text(text.document,contrast:value.contrast)); text.setSelectedRange(NSRange(location:0,length:0))
                text.setAccessibilityLabel(value.split ? String(localized:index == 0 ? "原始内容" : "修改后内容",bundle:.module,locale:value.locale) : "Diff")
            }
            signature = next; patch = value.patch
        }
        for text in views {
            text.canComment = value.canComment; text.contrast = value.contrast; text.begin = value.begin
            text.hit = { [weak self] point in self?.point(point) }; text.highlight = { [weak self] selection in self?.highlight(selection) }
            text.needsDisplay = true; text.window?.invalidateCursorRects(for:text)
        }
        refreshAnnotations(); resize()
        if changed { for (index,scroll) in scrolls.enumerated() where index < origins.count { scroll.contentView.scroll(to:origins[index]); scroll.reflectScrolledClipView(scroll.contentView) } }
    }
    private func configure(_ split:Bool) {
        observers.forEach(NotificationCenter.default.removeObserver); observers = []
        for scroll in scrolls { stack.removeArrangedSubview(scroll); scroll.removeFromSuperview() }; views = []; scrolls = []
        for _ in 0..<(split ? 2 : 1) {
            let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = true; scroll.autohidesScrollers = true; scroll.borderType = .noBorder
            let text = TaskDiffTextView(); text.isEditable = false; text.isSelectable = true; text.isRichText = false; text.allowsUndo = false; text.usesFindBar = true
            text.textContainerInset = NSSize(width:10,height:10); text.isVerticallyResizable = true; text.isHorizontallyResizable = true
            text.minSize = .zero; text.maxSize = NSSize(width:CGFloat.greatestFiniteMagnitude,height:CGFloat.greatestFiniteMagnitude)
            text.textContainer?.widthTracksTextView = false; text.textContainer?.containerSize = NSSize(width:CGFloat.greatestFiniteMagnitude,height:CGFloat.greatestFiniteMagnitude)
            text.annotations.attach(text); scroll.documentView = text; stack.addArrangedSubview(scroll); views.append(text); scrolls.append(scroll)
            scroll.contentView.postsBoundsChangedNotifications = true
            observers.append(NotificationCenter.default.addObserver(forName:NSView.boundsDidChangeNotification,object:scroll.contentView,queue:.main) { [weak self,weak scroll] _ in
                MainActor.assumeIsolated {
                    guard let self, let scroll else { return }; self.views.forEach { $0.annotations.position(); $0.needsDisplay = true; $0.window?.invalidateCursorRects(for:$0) }
                    guard !self.synchronizing else { return }; self.synchronizing = true; defer { self.synchronizing = false }
                    for other in self.scrolls where other !== scroll { other.contentView.scroll(to:CGPoint(x:other.contentView.bounds.minX,y:scroll.contentView.bounds.minY)); other.reflectScrolledClipView(other.contentView) }
                }
            })
        }
    }
    private func point(_ point:CGPoint) -> TaskDiffReviewPoint? {
        for (index,scroll) in scrolls.enumerated() where scroll.contentView.bounds.contains(scroll.contentView.convert(point,from:nil)) { return views[index].point(point) }; return nil
    }
    private func highlight(_ selection:TaskDiffReviewSelection) {
        guard let input else { return }
        for text in views { let ranges = DiffPresentation.selectedRows(text.document,patch:input.patch,selection:selection); text.selectedRanges = ranges.isEmpty ? [NSValue(range:NSRange(location:0,length:0))] : ranges.map(NSValue.init(range:)) }
    }
    private func refreshAnnotations() {
        guard let input else { return }; let labels = Dictionary(uniqueKeysWithValues:input.comments.map { ($0.id,$0.rangeLabel) })
        for text in views { text.annotations.update(DiffPresentation.annotations(input.comments,document:text.document),rangeLabels:labels,leadingInset:CGFloat(text.document.gutterCharacters)*DiffPresentation.unit,viewportAnchored:true,locale:input.locale,dark:input.dark,submit:input.submit,remove:input.remove,content:input.content) }
        DiffPresentation.pair(views.map(\.annotations),documents:views.map(\.document)); views.forEach { $0.annotations.position() }
    }
    private func resize() {
        for (index,text) in views.enumerated() {
            guard let layout = text.layoutManager, let container = text.textContainer else { continue }; layout.ensureLayout(for:container); let used = layout.usedRect(for:container)
            text.setFrameSize(NSSize(width:max(scrolls[index].contentSize.width,ceil(used.width)+24),height:max(scrolls[index].contentSize.height,ceil(used.height)+24,text.annotations.contentHeight)))
        }
    }
    override func layout() { super.layout(); refreshAnnotations(); resize() }
}
#else
private struct NativeTaskDiffView: UIViewRepresentable {
    let input:TaskDiffNativeInput
    func makeUIView(context:Context) -> TaskDiffHostView { TaskDiffHostView() }
    func updateUIView(_ view:TaskDiffHostView,context:Context) { view.update(input) }
}
private final class TaskDiffTextView:UITextView {
    var document = TaskDiffRenderedDocument(patch:"",side:nil)
    let annotations = TaskSourceAnnotations()
    var canComment = false, contrast = false
    var gutterWidth:CGFloat { CGFloat(document.gutterCharacters)*DiffPresentation.unit + textContainerInset.left }
    override func copy(_ sender:Any?) { let value = document.copied([selectedRange]); if !value.isEmpty { UIPasteboard.general.string = value } }
    func point(_ point:CGPoint) -> TaskDiffReviewPoint? {
        let y = min(max(point.y,bounds.minY),max(bounds.minY,bounds.maxY-1)) - textContainerInset.top
        let offset = layoutManager.characterIndex(for:CGPoint(x:0,y:y),in:textContainer,fractionOfDistanceBetweenInsertionPoints:nil)
        let side = document.side ?? (point.x - bounds.minX < textContainerInset.left + CGFloat(document.numberCharacters + 1) * DiffPresentation.unit ? "deletions" : "additions")
        return document.row(at:offset)?.point(side:side)
    }
    override func draw(_ rect:CGRect) {
        super.draw(rect); guard let context = UIGraphicsGetCurrentContext() else { return }
        let x = bounds.minX; context.setFillColor((backgroundColor ?? .systemBackground).cgColor); context.fill(CGRect(x:x,y:bounds.minY,width:gutterWidth,height:bounds.height))
        let origin = CGPoint(x:textContainerInset.left,y:textContainerInset.top)
        let glyphs = layoutManager.glyphRange(forBoundingRect:bounds.offsetBy(dx:-origin.x,dy:-origin.y),in:textContainer)
        for row in document.visibleRows(layoutManager.characterRange(forGlyphRange:glyphs,actualGlyphRange:nil)) {
            let rect = DiffPresentation.rowRect(row,layout:layoutManager,origin:origin)
            if let color = DiffPresentation.background(row.line?.kind,contrast:contrast) { context.setFillColor(color.cgColor); context.fill(CGRect(x:x,y:rect.minY,width:gutterWidth,height:20)) }
            let prefix = (document.text as NSString).substring(with:NSRange(location:row.range.location,length:(row.source?.location ?? row.range.location)-row.range.location))
            (prefix as NSString).draw(at:CGPoint(x:x+origin.x,y:rect.minY+2),withAttributes:[.font:DiffPresentation.font,.foregroundColor:UIColor.secondaryLabel])
            if canComment, row.point(side:document.side) != nil { UIImage(systemName:"plus")?.withTintColor(.secondaryLabel,renderingMode:.alwaysOriginal).draw(in:CGRect(x:x+1,y:rect.minY+4,width:9,height:9)) }
        }
    }
}
@MainActor final class TaskDiffHostView:UIView,UITextViewDelegate,UIGestureRecognizerDelegate {
    private var views:[TaskDiffTextView] = []
    private var input:TaskDiffNativeInput?, signature = "", patch:String?, synchronizing = false
    private var anchor:TaskDiffReviewPoint?, endpoint:TaskDiffReviewPoint?
    func update(_ value:TaskDiffNativeInput) {
        let next = value.identity + value.theme + String(value.split), changed = signature != next || patch != value.patch
        let origins = input?.identity == value.identity ? views.map(\.contentOffset) : []
        input = value
        if views.count != (value.split ? 2 : 1) { configure(value.split) }
        if changed {
            anchor = nil; endpoint = nil
            for (index,text) in views.enumerated() {
                text.document = TaskDiffRenderedDocument(patch:value.patch,side:value.split ? (index == 0 ? "deletions" : "additions") : nil)
                text.textStorage.setAttributedString(DiffPresentation.text(text.document,contrast:value.contrast)); text.selectedRange = NSRange(location:0,length:0)
                text.accessibilityLabel = value.split ? String(localized:index == 0 ? "原始内容" : "修改后内容",bundle:.module,locale:value.locale) : "Diff"
            }; signature = next; patch = value.patch
        }
        for text in views { text.canComment = value.canComment; text.contrast = value.contrast; text.setNeedsDisplay() }
        setNeedsLayout(); layoutIfNeeded()
        if changed { for (index,text) in views.enumerated() where index < origins.count { text.setContentOffset(origins[index],animated:false) } }
    }
    private func configure(_ split:Bool) {
        views.forEach { $0.removeFromSuperview() }; views = []
        for _ in 0..<(split ? 2 : 1) {
            let text = TaskDiffTextView(frame:.zero,textContainer:NSTextContainer(size:CGSize(width:CGFloat.greatestFiniteMagnitude,height:CGFloat.greatestFiniteMagnitude)))
            text.isEditable = false; text.isSelectable = true; text.delegate = self; text.backgroundColor = .systemBackground; text.contentInsetAdjustmentBehavior = .never
            text.textContainerInset = UIEdgeInsets(top:10,left:10,bottom:10,right:10); text.textContainer.widthTracksTextView = false; text.annotations.attach(text)
            let tap = UITapGestureRecognizer(target:self,action:#selector(tapGutter)), drag = UIPanGestureRecognizer(target:self,action:#selector(dragGutter))
            tap.delegate = self; drag.delegate = self; tap.require(toFail:drag); text.panGestureRecognizer.require(toFail:drag); text.addGestureRecognizer(tap); text.addGestureRecognizer(drag)
            addSubview(text); views.append(text)
        }
    }
    func gestureRecognizer(_ gestureRecognizer:UIGestureRecognizer,shouldReceive touch:UITouch) -> Bool {
        guard let text = gestureRecognizer.view as? TaskDiffTextView, text.canComment else { return false }
        return touch.location(in:text).x - text.bounds.minX < text.gutterWidth
    }
    private func point(_ point:CGPoint) -> TaskDiffReviewPoint? {
        for text in views { let local = text.convert(point,from:self); if text.bounds.contains(local) { return text.point(local) } }; return nil
    }
    @objc private func tapGutter(_ gesture:UITapGestureRecognizer) {
        guard gesture.state == .ended, let input, input.canComment, let point = point(gesture.location(in:self)) else { return }; endEditing(true); input.begin(TaskDiffReviewSelection(start:point.line,side:point.side,end:point.line,endSide:point.side))
    }
    @objc private func dragGutter(_ gesture:UIPanGestureRecognizer) {
        guard let input, input.canComment else { anchor = nil; endpoint = nil; return }
        if gesture.state == .began { anchor = point(gesture.location(in:self)) }
        guard let anchor else { return }
        if let point = point(gesture.location(in:self)) { endpoint = point }
        guard let endpoint else { return }
        let selection = TaskDiffReviewSelection(start:anchor.line,side:anchor.side,end:endpoint.line,endSide:endpoint.side)
        if gesture.state == .changed {
            for text in views { let ranges = DiffPresentation.selectedRows(text.document,patch:input.patch,selection:selection); if let first = ranges.first, let last = ranges.last { text.selectedRange = NSRange(location:first.location,length:NSMaxRange(last)-first.location) } else { text.selectedRange.length = 0 } }
        } else if gesture.state == .ended { self.anchor = nil; self.endpoint = nil; endEditing(true); views.forEach { $0.selectedRange.length = 0 }; input.begin(selection) }
        else if gesture.state == .cancelled || gesture.state == .failed { self.anchor = nil; self.endpoint = nil }
    }
    func textView(_ textView:UITextView,editMenuForTextIn range:NSRange,suggestedActions:[UIMenuElement]) -> UIMenu? {
        guard let text = textView as? TaskDiffTextView, let input, input.canComment, let selection = text.document.selection(NSRange(location:range.location,length:max(1,range.length))) else { return UIMenu(children:suggestedActions) }
        let identity = input.identity
        return UIMenu(children:suggestedActions + [UIAction(title:String(localized:"添加批注",bundle:.module),image:UIImage(systemName:"text.bubble")) { [weak self,weak text] _ in
            guard let self, let text, self.input?.identity == identity, self.input?.canComment == true else { return }; text.resignFirstResponder(); text.selectedRange.length = 0; self.input?.begin(selection)
        }])
    }
    func scrollViewDidScroll(_ scrollView:UIScrollView) {
        views.forEach { $0.annotations.position(); $0.setNeedsDisplay() }
        guard !synchronizing else { return }; synchronizing = true; defer { synchronizing = false }
        for text in views where text !== scrollView { text.setContentOffset(CGPoint(x:text.contentOffset.x,y:scrollView.contentOffset.y),animated:false) }
    }
    override func layoutSubviews() {
        super.layoutSubviews(); guard let input, !views.isEmpty else { return }
        let width = (bounds.width-CGFloat(views.count-1))/CGFloat(views.count), labels = Dictionary(uniqueKeysWithValues:input.comments.map { ($0.id,$0.rangeLabel) })
        for (index,text) in views.enumerated() {
            text.frame = CGRect(x:CGFloat(index)*(width+1),y:0,width:max(1,width),height:bounds.height)
            text.annotations.update(DiffPresentation.annotations(input.comments,document:text.document),rangeLabels:labels,leadingInset:CGFloat(text.document.gutterCharacters)*DiffPresentation.unit,viewportAnchored:true,locale:input.locale,dark:input.dark,submit:input.submit,remove:input.remove,content:input.content)
        }
        DiffPresentation.pair(views.map(\.annotations),documents:views.map(\.document))
        for text in views {
            text.layoutManager.ensureLayout(for:text.textContainer); text.annotations.position(); let used = text.layoutManager.usedRect(for:text.textContainer)
            text.contentSize = CGSize(width:max(text.bounds.width,ceil(used.width)+24),height:max(text.bounds.height,ceil(used.height)+24,text.annotations.contentHeight))
        }
    }
}
#endif
