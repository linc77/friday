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
    static let workingShelfEnabled = "friday.tasks.workingShelfEnabled"
    static let legacySidebar = "friday.tasks.legacySidebar"
    static let projectSort = "friday.tasks.projectSort"
    static let projectGrouping = "friday.tasks.projectGrouping"
    static let projectGroupingOverrides = "friday.tasks.projectGroupingOverrides"
    static let projectOrder = "friday.tasks.projectOrder"
    static let projectScope = "friday.tasks.projectScope"
    static let threadSort = "friday.tasks.threadSort"
    static let threadPreviewCount = "friday.tasks.threadPreviewCount"
}
