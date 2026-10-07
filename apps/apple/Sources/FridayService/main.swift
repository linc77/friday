import Foundation
import Darwin
import MachO

// exec replaces the helper so launchd sends SIGTERM directly to Node.
// launchd may pass BundleProgram as a relative argv[0], with / as its cwd.
var executableSize: UInt32 = 0
_NSGetExecutablePath(nil, &executableSize)
var executableBuffer = [CChar](repeating: 0, count: Int(executableSize))
_NSGetExecutablePath(&executableBuffer, &executableSize)
let executable = URL(fileURLWithPath: String(cString: executableBuffer)).resolvingSymlinksInPath()
let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
let bundle = Bundle(url: contents.deletingLastPathComponent())!
let runtime = contents.appendingPathComponent("Resources/runtime")
let node = contents.appendingPathComponent("MacOS/node").path
let directory = ProcessInfo.processInfo.environment["FRIDAY_DATA_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/Friday"
umask(0o077)
do {
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    for (name, descriptor) in [("service.log", STDOUT_FILENO), ("service-error.log", STDERR_FILENO)] {
        let file = open(directory + "/" + name, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        if file >= 0 { dup2(file, descriptor); close(file) }
    }
    guard FileManager.default.isExecutableFile(atPath: node) else {
        throw NSError(domain: "Friday.Service", code: 1, userInfo: [NSLocalizedDescriptionKey: "Bundled Node was not found at \(node) (helper: \(executable.path))."])
    }
    setenv("FRIDAY_DATA_DIR", directory, 1)
    setenv("FRIDAY_HOST", "127.0.0.1", 0)
    setenv("FRIDAY_PORT", "4317", 0)
    setenv("FRIDAY_APP_VERSION", bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown", 1)
    setenv("FRIDAY_SERVICE_BUILD", bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0", 1)
    setenv("PATH", contents.appendingPathComponent("MacOS").path + ":/opt/homebrew/bin:/usr/local/bin:" + NSHomeDirectory() + "/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin", 1)
    guard chdir(directory) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    let arguments = [node, runtime.appendingPathComponent("server/src/main.js").path]
    let pointers = arguments.map { strdup($0) }
    defer { pointers.forEach { free($0) } }
    (pointers + [nil]).withUnsafeBufferPointer { _ = execv(node, $0.baseAddress!) }
    throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "Could not launch bundled Node at \(node): \(String(cString: strerror(errno)))"])
} catch {
    fputs("Friday service failed to start: \(error.localizedDescription)\n", stderr)
    exit(1)
}
