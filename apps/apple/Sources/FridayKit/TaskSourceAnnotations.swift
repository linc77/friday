import SwiftUI
#if os(macOS)
import AppKit
private typealias AnnotationTextView = NSTextView
private typealias AnnotationHost = NSHostingView<AnyView>
#else
import UIKit
private typealias AnnotationTextView = UITextView
private final class AnnotationHost: UIView {
    let controller = UIHostingController(rootView: AnyView(EmptyView()))
    init() { super.init(frame: .zero); controller.view.backgroundColor = .clear; addSubview(controller.view) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    var rootView: AnyView { get { controller.rootView } set { controller.rootView = newValue } }
    override func layoutSubviews() { super.layoutSubviews(); controller.view.frame = bounds }
    func fitting(_ width: CGFloat) -> CGSize { controller.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)) }
}
#endif

private struct SourceAnnotationHeightKey: PreferenceKey {
    static var defaultValue: CGFloat { 0 }
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Annotation views occupy paragraph spacing, never source characters. Copy,
/// native editing, line offsets and undo therefore continue to use real bytes.
@MainActor final class TaskSourceAnnotations: NSObject, @preconcurrency NSLayoutManagerDelegate {
    private struct RenderKey: Equatable { let annotation: TaskFileLineAnnotation; let label: String?; let width: CGFloat; let locale: String; let dark: Bool }
    private final class Actions { var submit: (UUID, String) -> Void = { _, _ in }; var remove: (UUID) -> Void = { _ in }; var content: ((String) -> AnyView?)? }
    private let actions = Actions()
    private var keys: [UUID: RenderKey] = [:]
    private weak var text: AnnotationTextView?
    private var hosts: [UUID: AnnotationHost] = [:]
    private var annotations: [TaskFileLineAnnotation] = []
    private var heights: [Int: CGFloat] = [:]
    private var pairedHeights: [Int: CGFloat] = [:]
    var reservedHeights: [Int: CGFloat] { heights }
    private var lines = TaskSourceLines("")
    private var lastWidth: CGFloat = 0
    private var leadingInset: CGFloat = 0
    private var viewportAnchored = false
    private(set) var contentHeight: CGFloat = 0
    #if os(macOS)
    func attach(_ text: NSTextView) { self.text = text; text.layoutManager?.delegate = self }
    #else
    func attach(_ text: UITextView) { self.text = text; text.layoutManager.delegate = self }
    #endif
    func update(_ values: [TaskFileLineAnnotation], rangeLabels: [UUID: String] = [:], leadingInset: CGFloat = 0, viewportAnchored: Bool = false, locale: Locale, dark: Bool, submit: @escaping (UUID, String) -> Void, remove: @escaping (UUID) -> Void, content: ((String) -> AnyView?)? = nil) {
        guard let text else { return }; annotations = values; lines = TaskSourceLines(text.stringValue)
        self.leadingInset = leadingInset; self.viewportAnchored = viewportAnchored; actions.submit = submit; actions.remove = remove; actions.content = content
        let ids = Set(values.map(\.id))
        for id in Array(hosts.keys) where !ids.contains(id) { hosts.removeValue(forKey: id)?.removeFromSuperview(); keys.removeValue(forKey: id) }
        let width = max(80, text.visibleWidth - text.sourceInsetX - leadingInset - 16)
        var next: [Int: CGFloat] = [:]
        for value in values where value.range.end <= lines.starts.count {
            let host: AnnotationHost
            if let existing = hosts[value.id] { host = existing }
            else {
                #if os(macOS)
                host = AnnotationHost(rootView: AnyView(EmptyView()))
                #else
                host = AnnotationHost()
                #endif
                hosts[value.id] = host; text.addSubview(host)
            }
            host.isHidden = false
            let key = RenderKey(annotation: value, label: rangeLabels[value.id], width: width, locale: locale.identifier, dark: dark)
            if keys[value.id] != key {
            let actions = self.actions
            let card: AnyView
            if let id = value.presentationID { card = actions.content?(id) ?? AnyView(EmptyView()) }
            else { card = AnyView(TaskFileCommentCard(annotation: value, rangeLabel: rangeLabels[value.id], submit: { actions.submit($0, $1) }, remove: { actions.remove($0) })) }
            host.rootView = AnyView(card.environment(\.locale, locale).environment(\.colorScheme, dark ? .dark : .light).frame(width: width).fixedSize(horizontal: false, vertical: true)
                .background(GeometryReader { proxy in Color.clear.preference(key: SourceAnnotationHeightKey.self, value: proxy.size.height) })
                .onPreferenceChange(SourceAnnotationHeightKey.self) { [weak self] height in
                    DispatchQueue.main.async { self?.resize(value.id, height: height, key: key) }
                })
            #if os(macOS)
            let size = host.fittingSize
            #else
            let size = host.fitting(width)
            #endif
            host.frame.size = CGSize(width: width, height: max(value.text == nil ? 115 : 40, ceil(size.height)))
            keys[value.id] = key
            }
            next[value.range.end, default: 0] += host.frame.height
        }
        for value in values where value.range.end > lines.starts.count { hosts[value.id]?.isHidden = true }
        if next != heights || lastWidth != width {
            heights = next; lastWidth = width
            text.sourceLayout?.invalidateLayout(forCharacterRange: NSRange(location: 0, length: lines.length), actualCharacterRange: nil)
        }
        position()
    }
    func reserve(_ values: [Int: CGFloat]) {
        guard values != pairedHeights else { return }; pairedHeights = values
        text?.sourceLayout?.invalidateLayout(forCharacterRange: NSRange(location: 0, length: lines.length), actualCharacterRange: nil)
    }
    private func resize(_ id: UUID, height: CGFloat, key: RenderKey) {
        guard height.isFinite, height > 0, keys[id] == key, let host = hosts[id], abs(host.frame.height - ceil(height)) > 0.5 else { return }
        host.frame.size.height = ceil(height)
        #if os(macOS)
        text?.enclosingScrollView?.superview?.needsLayout = true
        #else
        text?.superview?.setNeedsLayout()
        #endif
    }
    func layoutManager(_ layoutManager: NSLayoutManager, paragraphSpacingAfterGlyphAt glyphIndex: Int, withProposedLineFragmentRect rect: CGRect) -> CGFloat {
        let number = lines.number(at: layoutManager.characterIndexForGlyph(at: glyphIndex)); return max(heights[number] ?? 0, pairedHeights[number] ?? 0)
    }
    func position() {
        guard let text, let layout = text.sourceLayout, let container = text.sourceContainer else { return }
        layout.ensureLayout(for: container); var offsets: [Int: CGFloat] = [:]; contentHeight = 0
        for value in annotations where value.range.end <= lines.starts.count {
            guard let host = hosts[value.id] else { continue }
            let range = lines.range(line: value.range.end), glyph: NSRange
            if range.length > 0 { glyph = layout.glyphRange(forCharacterRange: NSRange(location: NSMaxRange(range) - 1, length: 1), actualCharacterRange: nil) }
            else { glyph = NSRange(location: layout.numberOfGlyphs, length: 0) }
            let rect = glyph.location < layout.numberOfGlyphs ? layout.lineFragmentUsedRect(forGlyphAt: glyph.location, effectiveRange: nil) : layout.extraLineFragmentRect
            let offset = offsets[value.range.end, default: 0]
            host.frame.origin = CGPoint(x: text.sourceInsetX + leadingInset + (viewportAnchored ? text.sourceVisibleX : 0), y: rect.maxY + text.sourceInsetY + offset)
            offsets[value.range.end] = offset + host.frame.height; contentHeight = max(contentHeight, host.frame.maxY + 12)
        }
    }
}

private extension AnnotationTextView {
    #if os(macOS)
    var stringValue: String { string }
    var sourceLayout: NSLayoutManager? { layoutManager }
    var sourceContainer: NSTextContainer? { textContainer }
    var sourceInsetX: CGFloat { textContainerOrigin.x }
    var sourceInsetY: CGFloat { textContainerOrigin.y }
    var visibleWidth: CGFloat { enclosingScrollView?.contentSize.width ?? bounds.width }
    var sourceVisibleX: CGFloat { visibleRect.minX }
    #else
    var stringValue: String { text ?? "" }
    var sourceLayout: NSLayoutManager? { layoutManager }
    var sourceContainer: NSTextContainer? { textContainer }
    var sourceInsetX: CGFloat { textContainerInset.left }
    var sourceInsetY: CGFloat { textContainerInset.top }
    var visibleWidth: CGFloat { bounds.width }
    var sourceVisibleX: CGFloat { bounds.minX }
    #endif
}
