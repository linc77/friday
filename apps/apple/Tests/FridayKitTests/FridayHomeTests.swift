import Foundation

@main
struct FridayHomeTests {
    static func main() throws {
        let files = FileManager.default
        let home = files.temporaryDirectory.appendingPathComponent("friday-home-" + UUID().uuidString).path
        defer { try? files.removeItem(atPath: home) }
        let root = home + "/.friday", legacy = home + "/Library/Application Support/Friday"
        precondition(FridayHome.dataDirectory(environment: [:], home: home) == root + "/data")
        precondition(FridayHome.logs(environment: [:], home: home) == root + "/logs")
        try files.createDirectory(atPath: legacy, withIntermediateDirectories: true)
        try "synthetic-token".write(toFile: legacy + "/owner-token", atomically: true, encoding: .utf8)
        precondition(FridayHome.dataDirectory(environment: [:], home: home) == legacy)
        try files.createDirectory(atPath: root, withIntermediateDirectories: true)
        try files.createSymbolicLink(atPath: root + "/data", withDestinationPath: legacy)
        let resolved = FridayHome.dataDirectory(environment: [:], home: home)
        precondition(resolved == root + "/data")
        let token = try String(contentsOfFile: resolved + "/owner-token", encoding: .utf8)
        precondition(token == "synthetic-token")
        let custom = ["FRIDAY_HOME": home + "/custom"]
        precondition(FridayHome.dataDirectory(environment: custom, home: home) == home + "/custom/data")
        precondition(FridayHome.logs(environment: custom, home: home) == home + "/custom/logs")
        let isolated = ["FRIDAY_HOME": root, "FRIDAY_DATA_DIR": home + "/development"]
        precondition(FridayHome.dataDirectory(environment: isolated, home: home) == home + "/development")
        precondition(FridayHome.logs(environment: isolated, home: home) == home + "/development/logs")
        print("Friday home path checks passed")
    }
}
