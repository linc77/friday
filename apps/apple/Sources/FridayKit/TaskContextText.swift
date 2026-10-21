import SwiftUI
#if os(macOS)
import AppKit
typealias TaskContextFont = NSFont
#else
import UIKit
typealias TaskContextFont = UIFont
#endif

extension NSAttributedString.Key { static let fridayContextToken = NSAttributedString.Key("dev.friday.context-token") }

enum TaskContextText {
    #if os(macOS)
    static let pasteboardType = NSPasteboard.PasteboardType("dev.friday.context-document")
    static func copy(_ text: String) {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(TaskContextDocument.plain(text), forType: .string)
        if !TaskContextDocument.occurrences(text).isEmpty { NSPasteboard.general.setString(text, forType: pasteboardType) }
    }
    #else
    private static let pasteboardType = "dev.friday.context-document"
    static func copy(_ text: String) {
        var item: [String: Any] = ["public.utf8-plain-text": Data(TaskContextDocument.plain(text).utf8)]
        if !TaskContextDocument.occurrences(text).isEmpty { item[pasteboardType] = Data(text.utf8) }; UIPasteboard.general.items = [item]
    }
    static func pasted() -> String? { UIPasteboard.general.data(forPasteboardType: pasteboardType).flatMap { String(data: $0, encoding: .utf8) } ?? UIPasteboard.general.string }
    #endif
    static func document(_ text: String, records: [TaskContextReference], skills: [TaskComposerCatalog.Skill] = [], font: TaskContextFont) -> NSAttributedString {
        #if os(macOS)
        let color = NSColor.labelColor
        #else
        let color = UIColor.label
        #endif
        let result = NSMutableAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        let source = text as NSString
        struct Chip { let range:NSRange;let label:String;let symbol:String;let link:String;let invalid:Bool }
        let contextChips=TaskContextDocument.occurrences(text).map { occurrence -> Chip in
            let record=records.first { $0.id == occurrence.id && $0.kind == occurrence.kind }
            return Chip(range:occurrence.range,label:record?.label ?? occurrence.label,symbol:record?.symbol ?? "exclamationmark.circle",link:"friday-context://v1/\(occurrence.kind)/\(occurrence.id)",invalid:record == nil)
        }
        let citationChips=TaskAssistantCitation.occurrences(text).map { Chip(range:$0.range,label:$0.citation.label,symbol:"quote.opening",link:$0.citation.href,invalid:false) }
        let protected = (contextChips + citationChips).map(\.range)
        let skillChips = TaskComposerCommands.skillOccurrences(text, skills: skills).filter { occurrence in
            !protected.contains(where: { NSIntersectionRange($0, occurrence.range).length > 0 })
        }.map { Chip(range: $0.range, label: TaskComposerCommands.displayName($0.skill), symbol: "sparkles", link: "friday-skill://v1/" + $0.skill.name,
                     invalid: !$0.skill.enabled || $0.skill.userInvocable == false) }
        for occurrence in (contextChips+citationChips+skillChips).sorted(by: { $0.range.location > $1.range.location }) {
            let attachment = NSTextAttachment()
            attachment.image = chip(label: occurrence.label, symbol: occurrence.symbol, invalid: occurrence.invalid)
            let size = attachment.image?.size ?? CGSize(width: 100, height: 22)
            attachment.bounds = CGRect(x: 0, y: -4, width: size.width, height: size.height)
            let token = source.substring(with: occurrence.range)
            let part = NSMutableAttributedString(attachment: attachment)
            part.addAttributes([.fridayContextToken: token, .link: occurrence.link, .font: font], range: NSRange(location: 0, length: part.length))
            result.replaceCharacters(in: occurrence.range, with: part)
        }
        return result
    }
    struct SkillEdit { let range: NSRange; let replacement: NSAttributedString }
    /// Formatting uses native replacements during the same editing event, so
    /// Undo restores character positions before undoing the user's keystroke.
    static func skillEdits(_ attributed: NSAttributedString, skills: [TaskComposerCatalog.Skill], records: [TaskContextReference], font: TaskContextFont) -> [SkillEdit] {
        let text = canonical(attributed), source = text as NSString
        let protected = TaskContextDocument.occurrences(text).map(\.range) + TaskAssistantCitation.occurrences(text).map(\.range)
        let expected = TaskComposerCommands.skillOccurrences(text, skills: skills).filter { occurrence in !protected.contains(where: { NSIntersectionRange($0, occurrence.range).length > 0 }) }
        var edits: [SkillEdit] = []
        attributed.enumerateAttribute(.fridayContextToken, in: NSRange(location: 0, length: attributed.length)) { token, range, _ in
            let value = attributed.attribute(.link, at: range.location, effectiveRange: nil)
            guard let token = token as? String, let link = value as? String ?? (value as? URL)?.absoluteString, link.hasPrefix("friday-skill:") else { return }
            let model = modelRange(range, in: attributed)
            if !expected.contains(where: { NSIntersectionRange($0.range, model).length > 0 }) { edits.append(SkillEdit(range: range, replacement: NSAttributedString(string: token, attributes: [.font: font]))) }
        }
        for occurrence in expected {
            let range = viewRange(occurrence.range, in: attributed), token = source.substring(with: occurrence.range)
            if range.length == 1, attributed.attribute(.fridayContextToken, at: range.location, effectiveRange: nil) as? String == token { continue }
            edits.append(SkillEdit(range: range, replacement: document(token, records: records, skills: [occurrence.skill], font: font)))
        }
        return edits.sorted { $0.range.location > $1.range.location }
    }
    static func canonical(_ attributed: NSAttributedString) -> String {
        let result = NSMutableString(string: attributed.string)
        attributed.enumerateAttribute(.fridayContextToken, in: NSRange(location: 0, length: attributed.length), options: .reverse) { value, range, _ in
            if let token = value as? String { result.replaceCharacters(in: range, with: token) }
        }
        return result as String
    }
    static func modelRange(_ range: NSRange, in attributed: NSAttributedString) -> NSRange {
        let start = min(max(0, range.location), attributed.length); let end = min(max(start, NSMaxRange(range)), attributed.length)
        let before = canonical(attributed.attributedSubstring(from: NSRange(location: 0, length: start))).utf16.count
        let selected = canonical(attributed.attributedSubstring(from: NSRange(location: start, length: end - start))).utf16.count
        return NSRange(location: before, length: selected)
    }
    static func viewRange(_ range: NSRange, in attributed: NSAttributedString) -> NSRange {
        func position(_ model: Int) -> Int {
            var removed = 0; var result: Int?
            attributed.enumerateAttribute(.fridayContextToken, in: NSRange(location: 0, length: attributed.length)) { value, location, stop in
                guard let token = value as? String else { return }; let start = location.location + removed
                if model <= start { result = max(0, model - removed); stop.pointee = true; return }
                if model < start + token.utf16.count { result = NSMaxRange(location); stop.pointee = true; return }
                removed += token.utf16.count - location.length
            }
            return min(attributed.length, result ?? max(0, model - removed))
        }
        let start = position(range.location); let end = position(NSMaxRange(range)); return NSRange(location: start, length: max(0, end - start))
    }
    #if os(macOS)
    private static func chip(label: String, symbol: String, invalid: Bool) -> NSImage {
        let font = NSFont.systemFont(ofSize: 12, weight: .medium); let text = label as NSString
        let width = min(240, max(58, text.size(withAttributes: [.font: font]).width + 32))
        return NSImage(size: NSSize(width: width, height: 23), flipped: false) { bounds in
            let color = invalid ? NSColor.systemOrange : NSColor.controlAccentColor
            color.withAlphaComponent(0.12).setFill(); NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6).fill()
            color.withAlphaComponent(0.3).setStroke(); let outline = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6); outline.lineWidth = 0.5; outline.stroke()
            let icon = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 11, weight: .medium))
            icon?.draw(in: NSRect(x: 7, y: 5, width: 13, height: 13))
            let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingMiddle
            text.draw(in: NSRect(x: 25, y: 4, width: width - 31, height: 16), withAttributes: [.font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph])
            return true
        }
    }
    #else
    private static func chip(label: String, symbol: String, invalid: Bool) -> UIImage {
        let font = UIFont.systemFont(ofSize: 13, weight: .medium); let text = label as NSString
        let width = min(240, max(58, text.size(withAttributes: [.font: font]).width + 32))
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: 24)).image { _ in
            let color = invalid ? UIColor.systemOrange : UIColor(FridayTheme.accent)
            color.withAlphaComponent(0.12).setFill(); UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: width, height: 24), cornerRadius: 6).fill()
            UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .medium))?.withTintColor(color).draw(in: CGRect(x: 7, y: 5, width: 14, height: 14))
            let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingMiddle
            text.draw(in: CGRect(x: 25, y: 4, width: width - 31, height: 18), withAttributes: [.font: font, .foregroundColor: UIColor.label, .paragraphStyle: paragraph])
        }
    }
    #endif
}
