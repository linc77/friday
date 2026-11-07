import Foundation

enum ReleaseNoteCategory: String, Codable, CaseIterable {
    case features, improvements, fixes, updates

    var title: String {
        switch self {
        case .features: "新功能"
        case .improvements: "改进"
        case .fixes: "修复"
        case .updates: "更新"
        }
    }
}

struct ReleaseNotes: Codable, Identifiable {
    struct Section: Codable {
        let category: ReleaseNoteCategory
        let items: [String]
    }

    let version: String
    let build: Int
    let sections: [Section]
    var id: Int { build }
}

/// The receipt belongs to this application's defaults domain, so development
/// workspaces and the installed release never consume each other's announcements.
struct ReleaseNotesHistory {
    struct Receipt: Codable, Equatable {
        let build: Int
        let version: String
    }

    private static let receiptKey = "friday.releaseNotes.receipt"
    let releases: [ReleaseNotes]
    let current: ReleaseNotes
    private let defaults: UserDefaults

    init?(releases: [ReleaseNotes], currentBuild: Int, currentVersion: String, defaults: UserDefaults = .standard) {
        guard let current = releases.first(where: { $0.build == currentBuild && $0.version == currentVersion }) else { return nil }
        self.current = current
        self.releases = releases.filter { $0.build <= currentBuild }.sorted { $0.build > $1.build }
        self.defaults = defaults
    }

    var receipt: Receipt? {
        guard let data = defaults.data(forKey: Self.receiptKey) else { return nil }
        return try? JSONDecoder().decode(Receipt.self, from: data)
    }

    var unread: [ReleaseNotes] {
        guard let receipt else { return [current] }
        return releases.filter { $0.build > receipt.build }
    }

    func acknowledge() {
        // Opening an older application must not erase the newer read receipt.
        guard current.build > (receipt?.build ?? 0),
              let data = try? JSONEncoder().encode(Receipt(build: current.build, version: current.version)) else { return }
        defaults.set(data, forKey: Self.receiptKey)
    }
}
