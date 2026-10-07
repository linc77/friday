import AppKit
import Foundation
@testable import FridayKit

@MainActor
private final class PasteUndoDelegate: NSObject, NSTextViewDelegate {
    let history = UndoManager()
    func undoManager(for view: NSTextView) -> UndoManager? { history }
}

@main
struct IdeaBodyEditorTests {
    @MainActor static func main() throws {
        _ = NSApplication.shared
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=")!
        let image = try IdeaImageCache.importImage(png, name: "照片.png")
        let marker = IdeaBodyDocument.marker(image)
        let text = "图片之前\n\(marker)\n图片之后\nhttps://example.com"
        let rendered = NSMutableAttributedString(attributedString: IdeaBodyDocument.render(text, images: [image]))
        IdeaBodyDocument.detectLinks(in: rendered)
        let restored = IdeaBodyDocument.capture(rendered)
        precondition(restored.text == text && restored.images == [image], "Inline image position and plain URLs must survive reopening")
        let repeated = IdeaBodyDocument.render(marker + marker, images: [image])
        precondition(IdeaBodyDocument.capture(repeated).text == marker + marker, "Repeated copies of an image keep both positions")
        let location = (rendered.string as NSString).range(of: "\u{FFFC}")
        rendered.deleteCharacters(in: location)
        precondition(IdeaBodyDocument.capture(rendered).images.isEmpty, "Deleting an inline image removes its attachment metadata")
        let namedLink = "[资料](https://example.com/reference)"
        precondition(IdeaBodyDocument.capture(IdeaBodyDocument.render(namedLink, images: [])).text == namedLink, "Named links retain their destination")
        let plain = NSMutableAttributedString(string: "https://example.com")
        IdeaBodyDocument.detectLinks(in: plain)
        plain.replaceCharacters(in: NSRange(location: plain.length - 3, length: 3), with: "org")
        IdeaBodyDocument.detectLinks(in: plain)
        precondition(IdeaBodyDocument.capture(plain).text == "https://example.org", "Editing an automatically detected URL must not change its text into a named link")

        let board = NSPasteboard(name: NSPasteboard.Name("friday-note-test-" + UUID().uuidString))
        defer { board.releaseGlobally() }
        board.setData(png, forType: .png)
        let view = IdeaNativeTextView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        let delegate = PasteUndoDelegate(); delegate.history.groupsByEvent = false
        view.delegate = delegate
        view.isRichText = true; view.importsGraphics = true; view.allowsUndo = true
        view.textStorage?.setAttributedString(NSAttributedString(string: "前后"))
        view.setSelectedRange(NSRange(location: 1, length: 0))
        delegate.history.beginUndoGrouping()
        precondition(view.readSelection(from: board), "A normal image paste is accepted by the editor")
        delegate.history.endUndoGrouping()
        let pasted = IdeaBodyDocument.capture(view.attributedString())
        precondition(pasted.images.count == 1 && pasted.text == "前" + IdeaBodyDocument.marker(pasted.images[0]) + "后", "Image paste inserts at the caret rather than appending to a separate rail")
        precondition(delegate.history.canUndo, "Image paste belongs to the native undo history")
        delegate.history.undo()
        precondition(view.string == "前后" && IdeaBodyDocument.capture(view.attributedString()).images.isEmpty, "Undo restores both text and image metadata")
        delegate.history.redo()
        precondition(IdeaBodyDocument.capture(view.attributedString()).text == pasted.text, "Redo restores the inline image")

        let rich = NSMutableAttributedString(string: "文字\n")
        let external = NSTextAttachment()
        external.fileWrapper = FileWrapper(regularFileWithContents: png)
        external.fileWrapper?.preferredFilename = "剪贴板图片.png"
        rich.append(NSAttributedString(attachment: external))
        rich.append(NSAttributedString(string: "\n网页", attributes: [.link: URL(string: "https://example.com/page")!]))
        board.clearContents()
        board.setData(try rich.data(from: NSRange(location: 0, length: rich.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd]), forType: .rtfd)
        let mixed = try IdeaNativeTextView.pastedContent(board)!
        let imported = IdeaBodyDocument.capture(try IdeaBodyDocument.imported(mixed, existing: []))
        precondition(imported.images.count == 1 && imported.text.hasPrefix("文字\n![") && imported.text.hasSuffix("](https://example.com/page)"), "A mixed rich clipboard keeps its text, image and link in order")
        precondition(IdeaBodyDocument.capture(IdeaBodyDocument.render(imported.text, images: imported.images)).text == imported.text, "Rich pasted content survives persistence and reopening")
        precondition(IdeaBodyDocument.includingLegacyImages("旧笔记", images: [image]).contains(marker), "Existing separate attachments remain visible")
        print("Native note paste, inline persistence, image deletion and link checks passed")
    }
}
