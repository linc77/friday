// Compile with dmg-installer.swift and -D FRIDAY_INSTALLER_TEST. Uses temp apps only.
import Foundation

@main
enum DmgInstallerTests {
    static func main() {
        do { try check() }
        catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }

    static func check() throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent("friday-installer-test-" + UUID().uuidString)
        try files.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? files.removeItem(at: root) }
        let executable = URL(fileURLWithPath: CommandLine.arguments[1])
        let identifier = "dev.friday.installer-test"
        var checks = 0

        func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
            if try !condition() { throw InstallFailure.message(message) }
        }
        func fixture(_ name: String, _ version: String, id: String = "dev.friday.installer-test") throws -> URL {
            let app = root.appendingPathComponent(name + "/Friday.app")
            try files.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
            try files.createDirectory(at: app.appendingPathComponent("Contents/Resources"), withIntermediateDirectories: true)
            try files.copyItem(at: executable, to: app.appendingPathComponent("Contents/MacOS/FridayInstaller"))
            let plist = ["CFBundleIdentifier": id, "CFBundleExecutable": "FridayInstaller", "CFBundlePackageType": "APPL", "CFBundleName": "Friday", "CFBundleVersion": "1"]
            try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
            try version.write(to: app.appendingPathComponent("Contents/Resources/version.txt"), atomically: true, encoding: .utf8)
            let sign = Process(); sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
            sign.arguments = ["--force", "--sign", "-", app.path]
            sign.standardOutput = FileHandle.nullDevice
            try sign.run(); sign.waitUntilExit()
            try expect(sign.terminationStatus == 0, "Could not sign fixture")
            return app
        }
        func version(_ app: URL) throws -> String {
            try String(contentsOf: app.appendingPathComponent("Contents/Resources/version.txt"), encoding: .utf8)
        }
        func mustFail(_ operation: () throws -> Void) throws {
            var failed = false
            do { try operation() } catch { failed = true }
            try expect(failed, "Expected installation to fail")
        }
        func noWorkDirectories() throws {
            let enumerator = files.enumerator(at: root, includingPropertiesForKeys: nil)!
            while let file = enumerator.nextObject() as? URL {
                try expect(!file.lastPathComponent.hasPrefix(".friday-install-"), "Temporary installation directory leaked")
            }
        }

        let source = try fixture("source", "new")
        let fresh = root.appendingPathComponent("fresh/Friday.app")
        try DmgInstallation.install(source: source, destination: fresh, identifier: identifier)
        try expect(version(fresh) == "new", "Fresh installation missing")
        try expect(version(source) == "new", "Source was modified")
        checks += 1

        let existing = try fixture("existing", "old")
        try DmgInstallation.install(source: source, destination: existing, identifier: identifier)
        try expect(version(existing) == "new", "Replacement failed")
        checks += 1

        let invalid = try fixture("invalid", "signed")
        try "tampered".write(to: invalid.appendingPathComponent("Contents/Resources/version.txt"), atomically: true, encoding: .utf8)
        let untouched = try fixture("untouched", "old")
        try mustFail { try DmgInstallation.install(source: invalid, destination: untouched, identifier: identifier) }
        try expect(version(untouched) == "old", "Invalid signature changed existing app")
        checks += 1

        let rollback = try fixture("rollback", "old")
        try mustFail {
            try DmgInstallation.install(source: source, destination: rollback, identifier: identifier, move: { from, to in
                if from.lastPathComponent == "Friday.app" && from.deletingLastPathComponent().lastPathComponent.hasPrefix(".friday-install-") {
                    throw InstallFailure.message("Simulated activation failure")
                }
                try files.moveItem(at: from, to: to)
            })
        }
        try expect(version(rollback) == "old", "Previous application was not restored")
        checks += 1

        let foreign = try fixture("foreign", "foreign", id: "dev.other.app")
        try mustFail { try DmgInstallation.install(source: source, destination: foreign, identifier: identifier) }
        try expect(version(foreign) == "foreign", "Unrelated app was overwritten")
        checks += 1

        let link = root.appendingPathComponent("linked.app")
        try files.createSymbolicLink(at: link, withDestinationURL: foreign)
        try mustFail { try DmgInstallation.install(source: source, destination: link, identifier: identifier) }
        try expect(version(foreign) == "foreign", "Symlink target was overwritten")
        checks += 1

        try noWorkDirectories()
        print("Passed \(checks) DMG installer filesystem checks (temporary apps only).")
    }
}
