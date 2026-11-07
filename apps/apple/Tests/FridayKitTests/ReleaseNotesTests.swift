import Foundation

@main
struct ReleaseNotesTests {
    static func main() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let releases = try JSONDecoder().decode([ReleaseNotes].self, from: data)
        let current = releases[0]
        let suite = "dev.friday.release-notes-tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        func history(_ release: ReleaseNotes, defaults: UserDefaults) -> ReleaseNotesHistory {
            ReleaseNotesHistory(releases: releases, currentBuild: release.build, currentVersion: release.version, defaults: defaults)!
        }

        let firstLaunch = history(current, defaults: defaults)
        precondition(firstLaunch.unread.map(\.build) == [current.build], "A first launch shows this release, without pretending all history is new")
        precondition(firstLaunch.receipt == nil, "Preparing the announcement must not mark it read")
        precondition(ReleaseNotesHistory(releases: releases, currentBuild: current.build, currentVersion: "mismatched", defaults: defaults) == nil)

        // Start from the oldest release and skip several updates. All unread
        // releases must be included, while future releases stay out of old apps.
        let oldest = releases.last!
        let oldApp = history(oldest, defaults: defaults)
        precondition(oldApp.releases.map(\.build) == [oldest.build])
        oldApp.acknowledge()
        let restoredDefaults = UserDefaults(suiteName: suite)!
        let upgraded = history(current, defaults: restoredDefaults)
        precondition(upgraded.unread.map(\.build) == releases.filter { $0.build > oldest.build }.map(\.build))
        precondition(upgraded.receipt?.version == oldest.version)
        upgraded.acknowledge()
        precondition(history(current, defaults: UserDefaults(suiteName: suite)!).unread.isEmpty, "Ordinary launches must not repeat the announcement")
        precondition(upgraded.releases.count == releases.count, "Reading an announcement must not remove manual history")

        // Downgrading and reading older notes cannot consume or reset the newer receipt.
        oldApp.acknowledge()
        precondition(oldApp.unread.isEmpty)
        precondition(upgraded.receipt == ReleaseNotesHistory.Receipt(build: current.build, version: current.version))

        let isolatedSuite = suite + ".workspace"
        let isolatedDefaults = UserDefaults(suiteName: isolatedSuite)!
        defer { isolatedDefaults.removePersistentDomain(forName: isolatedSuite) }
        precondition(history(current, defaults: isolatedDefaults).unread.count == 1, "Each workspace must have an independent receipt")
        isolatedDefaults.set(Data("invalid".utf8), forKey: "friday.releaseNotes.receipt")
        precondition(history(current, defaults: isolatedDefaults).unread.count == 1, "Corrupt receipts must not hide new announcements")
        print("Release announcement decoding, first launch, skipped versions, persistent receipt, downgrade and workspace isolation passed.")
    }
}
