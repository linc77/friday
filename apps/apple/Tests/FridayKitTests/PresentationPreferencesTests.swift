import Foundation
import SwiftUI

@main
struct PresentationPreferencesTests {
    @MainActor static func main() throws {
        let suite = "dev.friday.presentation-tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let appearance = AppStorage(wrappedValue: FridayAppearance.system, FridayPreferenceKeys.appearance, store: defaults)
        let language = AppStorage(wrappedValue: FridayLanguage.chinese, FridayPreferenceKeys.language, store: defaults)
        precondition(appearance.wrappedValue == .system && language.wrappedValue == .chinese)
        appearance.wrappedValue = .dark
        language.wrappedValue = .english

        // Recreate the same SwiftUI storage used by a newly opened window.
        let restoredAppearance = AppStorage(wrappedValue: FridayAppearance.system, FridayPreferenceKeys.appearance, store: defaults)
        let restoredLanguage = AppStorage(wrappedValue: FridayLanguage.chinese, FridayPreferenceKeys.language, store: defaults)
        precondition(restoredAppearance.wrappedValue == .dark)
        precondition(restoredLanguage.wrappedValue == .english)
        precondition(defaults.string(forKey: FridayPreferenceKeys.language) == "en")
        precondition(FridayLanguage.chinese.locale.identifier == "zh-Hans")
        defaults.set("removed-theme", forKey: FridayPreferenceKeys.appearance)
        let fallback = AppStorage(wrappedValue: FridayAppearance.system, FridayPreferenceKeys.appearance, store: defaults)
        precondition(fallback.wrappedValue == .system, "Unknown saved choices must fall back safely")

        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        func strings(_ language: String) throws -> [String: String] {
            let data = try Data(contentsOf: root.appendingPathComponent("\(language).lproj/Localizable.strings"))
            return try PropertyListSerialization.propertyList(from: data, format: nil) as! [String: String]
        }
        let chinese = try strings("zh-Hans")
        let english = try strings("en")
        precondition(Set(chinese.keys) == Set(english.keys), "Both languages must cover the same UI keys")
        let placeholders = try NSRegularExpression(pattern: "%(@|lld)")
        func formats(_ string: String) -> [String] {
            placeholders.matches(in: string, range: NSRange(string.startIndex..., in: string)).map {
                String(string[Range($0.range, in: string)!])
            }
        }
        for (key, value) in english {
            precondition(!value.isEmpty)
            precondition(formats(key) == formats(value), "Interpolation mismatch: \(key)")
        }
        let bundle = Bundle(url: root.appendingPathComponent("en.lproj"))!
        precondition(bundle.localizedString(forKey: "外观", value: nil, table: nil) == "Appearance")
        precondition(bundle.localizedString(forKey: "正在验证…", value: nil, table: nil) == "Verifying…")
        print("Appearance persistence and \(english.count) bilingual UI strings passed")
    }
}
