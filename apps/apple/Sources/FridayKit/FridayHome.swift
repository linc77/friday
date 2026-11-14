import Foundation

/// Host paths only. iPhone continues to use its app container and paired host.
public enum FridayHome {
    public static func root(environment: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> String {
        environment["FRIDAY_HOME"] ?? home + "/.friday"
    }
    public static func dataDirectory(environment: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> String {
        if let explicit = environment["FRIDAY_DATA_DIR"] { return explicit }
        let directory = root(environment: environment, home: home) + "/data"
        let legacy = home + "/Library/Application Support/Friday"
        // The client can authenticate the old service before its first upgrade.
        if environment["FRIDAY_HOME"] == nil,
           !FileManager.default.fileExists(atPath: directory), FileManager.default.fileExists(atPath: legacy) { return legacy }
        return directory
    }
    public static func logs(environment: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> String {
        (environment["FRIDAY_DATA_DIR"] ?? root(environment: environment, home: home)) + "/logs"
    }
}
