import Foundation

enum MarkdownLinkPolicy {
    static func target(_ raw: String, workspacePath: String?, canOpenLocalFiles: Bool) -> URL? {
        guard !raw.unicodeScalars.contains(where: { [.control, .format].contains($0.properties.generalCategory) }) else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, let parsed = URL(string: value) else { return nil }
        let scheme = parsed.scheme?.lowercased()
        if ["http", "https"].contains(scheme ?? "") { return parsed.host?.isEmpty == false ? parsed : nil }
        if ["mailto", "tel"].contains(scheme ?? "") { return parsed }
        guard canOpenLocalFiles, scheme == nil || scheme == "file", !parsed.path.isEmpty else { return nil }
        guard parsed.host == nil || parsed.host == "" || parsed.host?.lowercased() == "localhost" else { return nil }
        guard !parsed.path.unicodeScalars.contains(where: { [.control, .format].contains($0.properties.generalCategory) }) else { return nil }
        let path = parsed.path.replacingOccurrences(of: ":\\d+(?::\\d+)?$", with: "", options: .regularExpression)
        if path.hasPrefix("/") { return URL(fileURLWithPath: path).standardizedFileURL }
        guard let workspacePath, !workspacePath.isEmpty else { return nil }
        return URL(fileURLWithPath: workspacePath, isDirectory: true).appendingPathComponent(path).standardizedFileURL
    }
    static func remoteImage(_ raw: String) -> URL? {
        guard let url = target(raw, workspacePath: nil, canOpenLocalFiles: false), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil else { return nil }
        return url
    }
}
