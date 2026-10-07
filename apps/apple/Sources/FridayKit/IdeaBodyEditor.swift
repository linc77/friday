import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
private typealias NoteNativeImage = NSImage
#else
import UIKit
private typealias NoteNativeImage = UIImage
#endif

// Only attachment metadata and text are synchronized. The native text system
// keeps images at the caret and supplies selection, composition and undo.
@MainActor
final class IdeaTextAttachment: NSTextAttachment {
    let noteImage: IdeaImage
    init(_ noteImage: IdeaImage) {
        self.noteImage = noteImage
        super.init(data: nil, ofType: noteImage.mediaType)
        if let data = IdeaImageCache.localData(noteImage.id) { image = NoteNativeImage(data: data) }
        bounds = CGRect(x: 0, y: 0, width: 280, height: 180)
    }
    required init?(coder: NSCoder) {
        guard let data = coder.decodeObject(of: NSData.self, forKey: "friday.image") as Data?,
              let metadata = try? JSONDecoder().decode(IdeaImage.self, from: data) else { return nil }
        noteImage = metadata
        super.init(coder: coder)
    }
    override func encode(with coder: NSCoder) {
        super.encode(with: coder)
        coder.encode(try? JSONEncoder().encode(noteImage), forKey: "friday.image")
    }
    override func attachmentBounds(for textContainer: NSTextContainer?, proposedLineFragment lineFrag: CGRect, glyphPosition position: CGPoint, characterIndex charIndex: Int) -> CGRect {
        let size = image?.size ?? bounds.size
        let width = min(size.width, max(80, min(640, lineFrag.width - 12)))
        let ratio = width / max(1, size.width)
        return CGRect(x: 0, y: 0, width: width, height: max(1, size.height * ratio))
    }
}

@MainActor
enum IdeaBodyDocument {
    private static let namedLink = NSAttributedString.Key("friday.noteLink")
    static var attributes: [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = 6
        #if os(macOS)
        let font = NSFont.systemFont(ofSize: 15)
        let color = NSColor.labelColor
        #else
        let font = UIFont.preferredFont(forTextStyle: .body)
        let color = UIColor.label
        #endif
        return [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
    }
    nonisolated static func marker(_ image: IdeaImage) -> String {
        let name = image.name.replacingOccurrences(of: "[", with: "").replacingOccurrences(of: "]", with: "").replacingOccurrences(of: "\n", with: " ")
        return "![\(name)](friday-image:\(image.id))"
    }
    nonisolated static func includingLegacyImages(_ text: String, images: [IdeaImage]) -> String {
        // Earlier notes stored their images in a separate rail. Keep those images
        // visible when opening them in the inline editor.
        images.reduce(text) { value, image in
            value.contains("(friday-image:\(image.id))") ? value : value + (value.isEmpty ? "" : "\n\n") + marker(image) + "\n"
        }
    }
    static func render(_ text: String, images: [IdeaImage]) -> NSAttributedString {
        let result = NSMutableAttributedString(string: "")
        let source = text as NSString
        let pattern = #"!\[[^\]]*\]\(friday-image:([a-f0-9]{64})\)|\[([^\]]+)\]\((https?://[^\s\)]+)\)"#
        let matches = (try? NSRegularExpression(pattern: pattern).matches(in: text, range: NSRange(location: 0, length: source.length))) ?? []
        var offset = 0
        for match in matches {
            result.append(NSAttributedString(string: source.substring(with: NSRange(location: offset, length: match.range.location - offset)), attributes: attributes))
            if match.range(at: 1).location != NSNotFound, let image = images.first(where: { $0.id == source.substring(with: match.range(at: 1)) }) {
                result.append(NSAttributedString(attachment: IdeaTextAttachment(image)))
            } else if match.range(at: 2).location != NSNotFound, let url = URL(string: source.substring(with: match.range(at: 3))) {
                var linked = attributes; linked[.link] = url; linked[namedLink] = url.absoluteString
                result.append(NSAttributedString(string: source.substring(with: match.range(at: 2)), attributes: linked))
            } else { result.append(NSAttributedString(string: source.substring(with: match.range), attributes: attributes)) }
            offset = NSMaxRange(match.range)
        }
        result.append(NSAttributedString(string: source.substring(from: offset), attributes: attributes))
        result.addAttributes(attributes, range: NSRange(location: 0, length: result.length))
        return result
    }
    static func capture(_ value: NSAttributedString) -> (text: String, images: [IdeaImage]) {
        var text = "", images: [IdeaImage] = []
        value.enumerateAttributes(in: NSRange(location: 0, length: value.length)) { attributes, range, _ in
            if let attachment = attributes[.attachment] as? IdeaTextAttachment {
                for _ in 0..<range.length { text += marker(attachment.noteImage) }
                if !images.contains(where: { $0.id == attachment.noteImage.id }) { images.append(attachment.noteImage) }
            } else {
                let string = (value.string as NSString).substring(with: range)
                let url = (attributes[namedLink] as? String).flatMap(URL.init(string:))
                if let url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""), string != url.absoluteString {
                    text += "[\(string.replacingOccurrences(of: "]", with: ""))](\(url.absoluteString.replacingOccurrences(of: ")", with: "%29")))"
                } else { text += string }
            }
        }
        return (text, images)
    }
    static func imported(_ value: NSAttributedString, existing: [IdeaImage]) throws -> NSAttributedString {
        let result = NSMutableAttributedString(string: "")
        var knownIDs = Set(existing.map(\.id))
        var failure: Error?
        value.enumerateAttributes(in: NSRange(location: 0, length: value.length)) { source, range, stop in
            do {
                if let attachment = source[.attachment] as? NSTextAttachment {
                    let image: IdeaImage
                    if let own = attachment as? IdeaTextAttachment { image = own.noteImage }
                    else {
                        #if os(macOS)
                        let data = attachment.fileWrapper?.regularFileContents ?? attachment.contents ?? attachment.image?.tiffRepresentation
                        #else
                        let data = attachment.fileWrapper?.regularFileContents ?? attachment.contents ?? attachment.image?.pngData()
                        #endif
                        guard let data else { throw ConnectionError.message("无法读取这张图片。") }
                        image = try IdeaImageCache.importImage(data, name: attachment.fileWrapper?.preferredFilename ?? "粘贴的图片")
                    }
                    knownIDs.insert(image.id)
                    guard knownIDs.count <= 20 else { throw ConnectionError.message("一篇笔记最多添加 20 张图片。") }
                    for _ in 0..<range.length { result.append(NSAttributedString(attachment: IdeaTextAttachment(image))) }
                } else {
                    var style = attributes
                    if let link = source[.link] as? URL {
                        style[.link] = link; style[namedLink] = link.absoluteString
                    } else if let link = source[.link] as? String {
                        style[.link] = link; style[namedLink] = link
                    }
                    result.append(NSAttributedString(string: (value.string as NSString).substring(with: range), attributes: style))
                }
            } catch { failure = error; stop.pointee = true }
        }
        if let failure { throw failure }
        return result
    }
    static func detectLinks(in storage: NSMutableAttributedString) {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return }
        storage.enumerateAttribute(namedLink, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            if value == nil { storage.removeAttribute(.link, range: range) }
        }
        for match in detector.matches(in: storage.string, range: NSRange(location: 0, length: storage.length)) {
            guard let url = match.url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  storage.attribute(.link, at: match.range.location, effectiveRange: nil) == nil else { continue }
            storage.addAttribute(.link, value: url, range: match.range)
        }
    }
}

#if os(macOS)
@MainActor
final class IdeaNativeTextView: NSTextView {
    var existingImages: [IdeaImage] = []
    var onError: (String) -> Void = { _ in }
    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] { [.rtfd, .rtf, .html, .png, .tiff, .fileURL, .URL, .string] }
    override func readSelection(from pasteboard: NSPasteboard) -> Bool {
        do {
            guard let value = try Self.pastedContent(pasteboard) else { return false }
            let content = try IdeaBodyDocument.imported(value, existing: existingImages)
            insertText(content, replacementRange: rangeForUserTextChange)
            return true
        } catch { onError(error.localizedDescription); return false }
    }
    override func readSelection(from pasteboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool { readSelection(from: pasteboard) }
    static func pastedContent(_ pasteboard: NSPasteboard) throws -> NSAttributedString? {
        let result = NSMutableAttributedString(string: "")
        for item in pasteboard.pasteboardItems ?? [] {
            var content: NSAttributedString?
            for (type, format) in [(NSPasteboard.PasteboardType.rtfd, NSAttributedString.DocumentType.rtfd), (.rtf, .rtf), (.html, .html)] {
                if let data = item.data(forType: type), let rich = try? NSAttributedString(data: data, options: [.documentType: format], documentAttributes: nil) {
                    content = rich; break
                }
            }
            if content == nil, let path = item.string(forType: .fileURL), let url = URL(string: path), url.isFileURL,
               (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType?.conforms(to: .image)) == true {
                let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 30 * 1024 * 1024 else { throw ConnectionError.message("请选择小于 30 MB 的图片。") }
                let image = try IdeaImageCache.importImage(Data(contentsOf: url), name: url.lastPathComponent)
                content = NSAttributedString(attachment: IdeaTextAttachment(image))
            }
            if content == nil, let data = item.data(forType: .png) ?? item.data(forType: .tiff) {
                let image = try IdeaImageCache.importImage(data, name: "粘贴的图片")
                content = NSAttributedString(attachment: IdeaTextAttachment(image))
            }
            if content == nil, let string = item.string(forType: .string) ?? item.string(forType: .URL) { content = NSAttributedString(string: string) }
            if let content {
                if result.length > 0 { result.append(NSAttributedString(string: "\n")) }
                result.append(content)
            }
        }
        return result.length == 0 ? nil : result
    }
}

struct IdeaBodyEditor: NSViewRepresentable {
    let text: String
    let images: [IdeaImage]
    let imageData: (String) async throws -> Data
    let onChange: (String, [IdeaImage]) -> Void
    let onError: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let view = IdeaNativeTextView(frame: .zero)
        view.isRichText = true; view.importsGraphics = true; view.allowsUndo = true
        view.isAutomaticLinkDetectionEnabled = true; view.isAutomaticQuoteSubstitutionEnabled = false
        view.drawsBackground = false; view.isVerticallyResizable = true; view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]; view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        view.textContainerInset = NSSize(width: 0, height: 8)
        view.typingAttributes = IdeaBodyDocument.attributes
        view.setAccessibilityLabel("笔记正文")
        let scroll = NSScrollView(); scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.documentView = view
        view.delegate = context.coordinator
        context.coordinator.install(view)
        return scroll
    }
    func updateNSView(_ view: NSScrollView, context: Context) {
        context.coordinator.parent = self
        if let textView = view.documentView as? IdeaNativeTextView { context.coordinator.install(textView) }
    }
    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: IdeaBodyEditor
        var appliedText: String?
        init(_ parent: IdeaBodyEditor) { self.parent = parent }
        func install(_ view: IdeaNativeTextView) {
            view.existingImages = parent.images; view.onError = parent.onError
            guard appliedText != parent.text, !view.hasMarkedText() else { return }
            appliedText = parent.text
            view.textStorage?.setAttributedString(IdeaBodyDocument.render(parent.text, images: parent.images))
            if let storage = view.textStorage { IdeaBodyDocument.detectLinks(in: storage) }
            view.typingAttributes = IdeaBodyDocument.attributes
            loadImages(view)
        }
        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? IdeaNativeTextView, let storage = view.textStorage else { return }
            if !view.hasMarkedText() { IdeaBodyDocument.detectLinks(in: storage) }
            let content = IdeaBodyDocument.capture(storage)
            appliedText = content.text; view.existingImages = content.images
            if !view.hasMarkedText() { view.typingAttributes = IdeaBodyDocument.attributes }
            parent.onChange(content.text, content.images)
        }
        private func loadImages(_ view: IdeaNativeTextView) {
            guard let storage = view.textStorage else { return }
            storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, _, _ in
                guard let attachment = value as? IdeaTextAttachment, attachment.image == nil else { return }
                Task { [weak view] in
                    do {
                        attachment.image = NSImage(data: try await parent.imageData(attachment.noteImage.id))
                        guard let storage = view?.textStorage else { return }
                        storage.edited(.editedAttributes, range: NSRange(location: 0, length: storage.length), changeInLength: 0)
                    } catch { parent.onError(error.localizedDescription) }
                }
            }
        }
    }
}
#else
struct IdeaBodyEditor: UIViewRepresentable {
    let text: String
    let images: [IdeaImage]
    let imageData: (String) async throws -> Data
    let onChange: (String, [IdeaImage]) -> Void
    let onError: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(usingTextLayoutManager: false)
        view.backgroundColor = .clear; view.allowsEditingTextAttributes = true
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        view.pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.text.identifier, UTType.rtf.identifier, UTType.rtfd.identifier, UTType.html.identifier, UTType.image.identifier, UTType.url.identifier])
        view.accessibilityLabel = "笔记正文"
        view.delegate = context.coordinator; view.pasteDelegate = context.coordinator
        context.coordinator.install(view)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) { context.coordinator.parent = self; context.coordinator.install(view) }
    @MainActor final class Coordinator: NSObject, UITextViewDelegate, UITextPasteDelegate {
        var parent: IdeaBodyEditor
        var appliedText: String?
        init(_ parent: IdeaBodyEditor) { self.parent = parent }
        func install(_ view: UITextView) {
            guard appliedText != parent.text, view.markedTextRange == nil else { return }
            appliedText = parent.text
            view.attributedText = IdeaBodyDocument.render(parent.text, images: parent.images)
            IdeaBodyDocument.detectLinks(in: view.textStorage)
            view.typingAttributes = IdeaBodyDocument.attributes
            view.textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: view.textStorage.length)) { value, _, _ in
                guard let attachment = value as? IdeaTextAttachment, attachment.image == nil else { return }
                Task { [weak view] in
                    do {
                        attachment.image = UIImage(data: try await parent.imageData(attachment.noteImage.id))
                        guard let storage = view?.textStorage else { return }
                        storage.edited(.editedAttributes, range: NSRange(location: 0, length: storage.length), changeInLength: 0)
                    } catch { parent.onError(error.localizedDescription) }
                }
            }
        }
        func textViewDidChange(_ view: UITextView) {
            if view.markedTextRange == nil { IdeaBodyDocument.detectLinks(in: view.textStorage) }
            let content = IdeaBodyDocument.capture(view.attributedText)
            appliedText = content.text
            if view.markedTextRange == nil { view.typingAttributes = IdeaBodyDocument.attributes }
            parent.onChange(content.text, content.images)
        }
        func textPasteConfigurationSupporting(_ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting, transform item: UITextPasteItem) {
            guard item.itemProvider.canLoadObject(ofClass: UIImage.self) else { item.setDefaultResult(); return }
            _ = item.itemProvider.loadObject(ofClass: UIImage.self) { image, error in
                Task { @MainActor in
                    do {
                        guard let data = (image as? UIImage)?.pngData() else { throw error ?? ConnectionError.message("无法读取这张图片。") }
                        let metadata = try IdeaImageCache.importImage(data, name: "粘贴的图片")
                        item.setResult(attachment: IdeaTextAttachment(metadata))
                    } catch { self.parent.onError(error.localizedDescription); item.setNoResult() }
                }
            }
        }
        func textPasteConfigurationSupporting(_ target: UITextPasteConfigurationSupporting, performPasteOf attributedString: NSAttributedString, to textRange: UITextRange) -> UITextRange {
            guard let view = target as? UITextView else { return textRange }
            do {
                let content = try IdeaBodyDocument.imported(attributedString, existing: parent.images)
                let range = NSRange(location: view.offset(from: view.beginningOfDocument, to: textRange.start), length: view.offset(from: textRange.start, to: textRange.end))
                replace(in: view, range: range, with: content)
                return view.selectedTextRange ?? textRange
            } catch { parent.onError(error.localizedDescription); return textRange }
        }
        private func replace(in view: UITextView, range: NSRange, with content: NSAttributedString) {
            let previous = view.attributedText.attributedSubstring(from: range)
            view.undoManager?.registerUndo(withTarget: self) { coordinator in
                coordinator.replace(in: view, range: NSRange(location: range.location, length: content.length), with: previous)
            }
            view.textStorage.replaceCharacters(in: range, with: content)
            view.selectedRange = NSRange(location: range.location + content.length, length: 0)
            view.typingAttributes = IdeaBodyDocument.attributes
            textViewDidChange(view)
        }
    }
}
#endif
