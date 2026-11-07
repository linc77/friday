import Foundation

// T3 shared/path.newProjectFolderName; source notice: task-sidebar-order.ts.
enum ManagedProjectNaming {
    static func normalizeCloneRemote(_ input: String) -> String {
        let remote = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if remote.range(of: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]+(?:\\.git)?$", options: .regularExpression) != nil { return "https://github.com/" + remote + (remote.hasSuffix(".git") ? "" : ".git") }
        return remote
    }
    static func publicCloneRemote(_ remote: String) -> String {
        guard var url = URLComponents(string: remote), url.scheme != nil, url.host != nil else { return remote }
        guard url.user != nil || url.password != nil || url.query != nil else { return remote }
        url.user = nil; url.password = nil; url.query = nil; return url.string ?? remote
    }
    static func cloneDirectoryName(_ input: String) -> String {
        let value = String(input.prefix { $0 != "?" && $0 != "#" }).trimmingCharacters(in: .whitespacesAndNewlines)
        let scheme = value.range(of: "://"), hasHost = scheme != nil || value.range(of: "^[^/\\\\:]+@[^/\\\\:]+:", options: .regularExpression) != nil
        let path = scheme.map { String(value[$0.upperBound...]) } ?? value
        let parts = path.components(separatedBy: CharacterSet(charactersIn: "/\\:")).filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if hasHost && (parts.count < 2 || parts.count == 2 && parts.last?.range(of: "^\\d+$", options: .regularExpression) != nil) { return "" }
        let name = parts.last ?? ""; return name.hasSuffix(".git") ? String(name.dropLast(4)) : name
    }
    static func folderName(_ name: String) -> String {
        let decomposed = name.decomposedStringWithCompatibilityMapping.unicodeScalars.filter { !(0x0300...0x036f).contains($0.value) }
        let lower = String(String.UnicodeScalarView(decomposed)).lowercased()
        var value = "", separator = false
        for scalar in lower.unicodeScalars {
            if (97...122).contains(scalar.value) || (48...57).contains(scalar.value) {
                if separator && !value.isEmpty { value.append("-") }; value.unicodeScalars.append(scalar); separator = false
            } else { separator = true }
        }
        value = String(value.prefix(64)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        if value.isEmpty { return "project" }
        if value.range(of: "^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", options: .regularExpression) != nil { value += "-project" }
        return value
    }
}
