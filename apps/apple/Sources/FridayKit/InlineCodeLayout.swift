import SwiftUI
#if os(macOS)
import AppKit
private typealias InlineCodeColor = NSColor
#else
import UIKit
private typealias InlineCodeColor = UIColor
#endif

extension NSAttributedString.Key {
    static let fridayInlineCode = NSAttributedString.Key("FridayInlineCode")
}

/// Decorations stay outside the source string so selection, citations and copy
/// continue to use the original character offsets, including emoji and CJK.
@MainActor enum InlineCodeLayout {
    static func padding(_ font: ReadingNativeFont) -> CGFloat { font.pointSize * 0.35 }
    static func prepare(_ text: NSMutableAttributedString) {
        let source = text.string as NSString
        var spans: [NSRange] = []
        text.enumerateAttribute(.fridayInlineCode, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            if value != nil { spans.append(range) }
        }
        for range in spans {
            guard let font = text.attribute(.font, at: range.location, effectiveRange: nil) as? ReadingNativeFont else { continue }
            // Reserve space at both boundaries without inserting padding characters.
            // The background uses half of this gap on each side of the code.
            for index in [range.location - 1, NSMaxRange(range) - 1] where index >= 0 {
                let character = source.rangeOfComposedCharacterSequence(at: index)
                if source.substring(with: character).contains(where: \.isNewline) { continue }
                let existing = (text.attribute(.kern, at: index, effectiveRange: nil) as? NSNumber)?.doubleValue ?? 0
                text.addAttribute(.kern, value: existing + Double(padding(font) * 2), range: character)
            }
        }
    }
    static func inset(_ text: NSAttributedString) -> CGSize {
        var horizontal: CGFloat = 0, vertical: CGFloat = 0
        text.enumerateAttribute(.fridayInlineCode, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            guard value != nil, let font = text.attribute(.font, at: range.location, effectiveRange: nil) as? ReadingNativeFont else { return }
            horizontal = max(horizontal, padding(font))
            vertical = max(vertical, font.pointSize * 0.1)
        }
        return CGSize(width: ceil(horizontal), height: ceil(vertical))
    }
}

/// TextKit draws a separate rounded background for each wrapped line.
final class InlineCodeLayoutManager: NSLayoutManager {
    func codeBackgrounds(in glyphRange: NSRange) -> [(CGRect, Any)] {
        guard let storage = textStorage, glyphRange.length > 0 else { return [] }
        var backgrounds: [(CGRect, Any)] = []
        let characters = characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)
        storage.enumerateAttribute(.fridayInlineCode, in: characters) { value, range, _ in
            guard let color = value as? InlineCodeColor,
                  let font = storage.attribute(.font, at: range.location, effectiveRange: nil) as? ReadingNativeFont else { return }
            let codeGlyphs = self.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            self.enumerateLineFragments(forGlyphRange: codeGlyphs) { line, _, container, lineGlyphs, _ in
                let segment = NSIntersectionRange(codeGlyphs, lineGlyphs)
                guard segment.length > 0 else { return }
                var rect = self.boundingRect(forGlyphRange: segment, in: container)
                let lastCharacter = self.characterIndexForGlyph(at: NSMaxRange(segment) - 1)
                let kern = (storage.attribute(.kern, at: lastCharacter, effectiveRange: nil) as? NSNumber)?.doubleValue ?? 0
                rect.size.width = max(0, rect.width - CGFloat(kern))
                let baseline = line.minY + self.location(forGlyphAt: segment.location).y
                rect.origin.y = baseline - font.ascender
                rect.size.height = font.ascender - font.descender
                rect = rect.insetBy(dx: -font.pointSize * 0.35, dy: -font.pointSize * 0.1)
                backgrounds.append((rect, color))
            }
        }
        return backgrounds
    }
    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
        for (rect, value) in codeBackgrounds(in: glyphsToShow) {
            guard let color = value as? InlineCodeColor else { continue }
            color.setFill()
            let box = rect.offsetBy(dx: origin.x, dy: origin.y)
            #if os(macOS)
            NSBezierPath(roundedRect: box, xRadius: 4, yRadius: 4).fill()
            #else
            UIBezierPath(roundedRect: box, cornerRadius: 4).fill()
            #endif
        }
        // Keep selection and search highlights above the decorative surface.
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    }
}
