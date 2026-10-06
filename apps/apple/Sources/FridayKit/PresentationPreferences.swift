import Foundation

enum FridayAppearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: "系统"
        case .light: "浅色"
        case .dark: "深色"
        }
    }
}

enum FridayLanguage: String, CaseIterable, Identifiable {
    case chinese = "zh-Hans"
    case english = "en"
    var id: String { rawValue }
    var title: String { self == .chinese ? "简体中文" : "English" }
    var locale: Locale { Locale(identifier: rawValue) }
}

enum FridayPreferenceKeys {
    static let appearance = "friday.appearance"
    static let language = "friday.language"
}
