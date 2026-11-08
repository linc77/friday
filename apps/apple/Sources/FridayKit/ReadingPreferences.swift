import SwiftUI
#if os(macOS)
import AppKit
typealias ReadingNativeFont = NSFont
#else
import UIKit
typealias ReadingNativeFont = UIFont
#endif

enum CodeColorTheme: String, Codable, CaseIterable, Identifiable {
    case pierre, github, vscode, catppuccin
    var id: String { rawValue }
    var title: String {
        switch self {
        case .pierre: "Pierre"
        case .github: "GitHub"
        case .vscode: "Visual Studio Code"
        case .catppuccin: "Catppuccin"
        }
    }
}

struct ReadingStyle: Codable, Equatable {
    static let storageKey = "friday.appearance.reading"
    var bodyFamily = ""
    var codeFamily = ""
    #if os(macOS)
    var bodySize = 15.0
    #else
    var bodySize = 16.0
    #endif
    var codeSize = 12.0
    /// Zero lets the conversation fill the available width.
    var width = 780.0
    var codeTheme: CodeColorTheme = .pierre

    var validated: Self {
        var value = self
        value.bodySize = bodySize.isFinite ? min(24, max(12, bodySize)) : Self().bodySize
        value.codeSize = codeSize.isFinite ? min(22, max(10, codeSize)) : Self().codeSize
        value.width = width == 0 ? 0 : width.isFinite ? min(1600, max(560, width)) : 780
        value.bodyFamily = String(bodyFamily.trimmingCharacters(in: .whitespacesAndNewlines).prefix(128))
        value.codeFamily = String(codeFamily.trimmingCharacters(in: .whitespacesAndNewlines).prefix(128))
        return value
    }
    static var current: Self {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let value = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return value.validated
    }
    var contentWidth: CGFloat { width == 0 ? .infinity : CGFloat(width) }
    var bodyFont: Font { Font(nativeFont()) }
    var codeFont: Font { Font(nativeFont(code: true)) }
    var compactFont: Font { Font(nativeFont(scale: 14.0 / 15.0)) }
    func inlineCodeFont(relativeTo font: ReadingNativeFont) -> ReadingNativeFont {
        let code = nativeFont(code: true)
        #if os(macOS)
        return ReadingNativeFont(descriptor: code.fontDescriptor, size: font.pointSize * 0.85) ?? code
        #else
        return ReadingNativeFont(descriptor: code.fontDescriptor, size: font.pointSize * 0.85)
        #endif
    }
    var lineHeight: CGFloat { (nativeFont().pointSize * 1.4).rounded() }
    var lineSpacing: CGFloat {
        let font = nativeFont()
        return max(0, lineHeight - (font.ascender - font.descender + font.leading))
    }
    static func headingScale(_ level: Int) -> CGFloat {
        switch level { case 1: 1.6; case 2: 1.4; case 3: 1.2; case 4: 1.1; default: 1 }
    }

    /// Resolve a weight within the selected family instead of applying the native Bold trait.
    static func semibold(_ font: ReadingNativeFont) -> ReadingNativeFont {
        let systemMono = ReadingNativeFont.monospacedSystemFont(ofSize: font.pointSize, weight: .regular)
        if font.familyName == systemMono.familyName {
            return .monospacedSystemFont(ofSize: font.pointSize, weight: .semibold)
        }
        var attributes = font.fontDescriptor.fontAttributes
        attributes.removeValue(forKey: .name)
        attributes.removeValue(forKey: .face)
        #if os(macOS)
        var traits = font.fontDescriptor.object(forKey: .traits) as? [NSFontDescriptor.TraitKey: Any] ?? [:]
        traits[.symbolic] = font.fontDescriptor.symbolicTraits.subtracting(.bold).rawValue
        traits[.weight] = NSFont.Weight.semibold.rawValue
        attributes[.traits] = traits
        return NSFont(descriptor: NSFontDescriptor(fontAttributes: attributes), size: font.pointSize) ?? font
        #else
        var traits = font.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any] ?? [:]
        traits[.symbolic] = font.fontDescriptor.symbolicTraits.subtracting(.traitBold).rawValue
        traits[.weight] = UIFont.Weight.semibold.rawValue
        attributes[.traits] = traits
        return UIFont(descriptor: UIFontDescriptor(fontAttributes: attributes), size: font.pointSize)
        #endif
    }

    func nativeFont(code: Bool = false, scale: CGFloat = 1) -> ReadingNativeFont {
        let family = code ? codeFamily : bodyFamily
        let size = CGFloat(code ? codeSize : bodySize) * scale
        #if os(macOS)
        if !family.isEmpty, let font = NSFontManager.shared.font(withFamily: family, traits: [], weight: 5, size: size) { return font }
        return code ? .monospacedSystemFont(ofSize: size, weight: .regular) : .systemFont(ofSize: size)
        #else
        let base = family.isEmpty ? nil : UIFont.fontNames(forFamilyName: family).first.flatMap { UIFont(name: $0, size: size) }
        let font = base ?? (code ? .monospacedSystemFont(ofSize: size, weight: .regular) : .systemFont(ofSize: size))
        return UIFontMetrics(forTextStyle: code ? .callout : .body).scaledFont(for: font)
        #endif
    }
}

/// Each reader observes the same saved value, including views in sheets/windows.
@propertyWrapper
struct ReadingPreferences: DynamicProperty {
    @AppStorage(ReadingStyle.storageKey) private var data = Data()
    var wrappedValue: ReadingStyle {
        get { ((try? JSONDecoder().decode(ReadingStyle.self, from: data)) ?? ReadingStyle()).validated }
        nonmutating set { if let encoded = try? JSONEncoder().encode(newValue.validated) { data = encoded } }
    }
    var projectedValue: Binding<ReadingStyle> {
        Binding(get: { wrappedValue }, set: { wrappedValue = $0 })
    }
}
