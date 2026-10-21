import Foundation
import Security

enum SecureToken {
    static func read(for server: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.friday.connection", kSecAttrAccount as String: server, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ token: String, for server: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.friday.connection", kSecAttrAccount as String: server]
        let data = Data(token.utf8)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var attributes = query; attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(attributes as CFDictionary, nil)
        }
        if status != errSecSuccess { throw ConnectionError.message("无法将设备凭据保存到钥匙串（\(status)）") }
    }
}
enum ConnectionError: LocalizedError {
    case message(String)
    case http(String, statusCode: Int)
    case rateLimited(String, retryAt: Date?)
    var errorDescription: String? { switch self { case .message(let text), .rateLimited(let text, _), .http(let text, _): return text } }
    var statusCode: Int? { if case .http(_, let code) = self { return code }; return nil }
    var retryAt: Date? { if case .rateLimited(_, let date) = self { return date }; return nil }
}
@MainActor
final class Connection {
    var server: String
    var token: String
    init(defaults: UserDefaults = .standard,
         environment: [String: String] = ProcessInfo.processInfo.environment,
         development: Bool = Bundle.main.bundleIdentifier?.hasPrefix("dev.friday.mac.workspace.") == true) {
        server = defaults.string(forKey: "friday.server") ?? "http://127.0.0.1:4317"
        token = SecureToken.read(for: server) ?? ""
        #if os(macOS)
        if let previewServer = environment["FRIDAY_SERVER_URL"] {
            server = previewServer; token = ""
            // Finder and the Dock do not retain `open --env` launch overrides.
            // Save the preview address in this workspace's own preferences.
            if development {
                defaults.set(server, forKey: "friday.server")
                if let directory = environment["FRIDAY_DATA_DIR"] {
                    defaults.set(["server": server, "directory": directory], forKey: "friday.developmentConnection")
                }
            }
        }
        if token.isEmpty && ["127.0.0.1", "localhost"].contains(URL(string: server)?.host ?? "") {
            let saved = development ? defaults.dictionary(forKey: "friday.developmentConnection") : nil
            let savedDirectory = saved?["server"] as? String == server ? saved?["directory"] as? String : nil
            let directory = environment["FRIDAY_DATA_DIR"] ?? savedDirectory ?? NSHomeDirectory() + "/Library/Application Support/Friday"
            token = (try? String(contentsOfFile: directory + "/owner-token", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) ?? ""
        }
        #endif
    }
    func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        guard let base = URL(string: server), let host = base.host, ["http", "https"].contains(base.scheme ?? "") else { throw ConnectionError.message("请输入有效的服务地址") }
        if base.scheme == "http" && !["127.0.0.1", "localhost", "::1"].contains(host) { throw ConnectionError.message("远程连接请使用 HTTPS 地址，例如 Tailscale Serve 提供的地址") }
        guard let url = URL(string: server.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else { throw ConnectionError.message("服务地址无效") }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 30
        if path.hasPrefix("/api/") { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return request
    }
    func data(_ path: String, method: String = "GET", body: [String: Any]? = nil, timeout: TimeInterval? = nil) async throws -> Data {
        var outgoing = try request(path, method: method, body: body); if let timeout { outgoing.timeoutInterval = timeout }
        let (data, response) = try await URLSession.shared.data(for: outgoing)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let failure = try? JSONDecoder().decode(APIError.self, from: data)
            if (response as? HTTPURLResponse)?.statusCode == 429 {
                let retryAt = failure?.retryAt.map { Date(timeIntervalSince1970: $0 / 1000) }
                    ?? (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init).map { Date().addingTimeInterval(max(0, $0)) }
                throw ConnectionError.rateLimited(failure?.error ?? "Source Control 请求过于频繁，请稍后重试", retryAt: retryAt)
            }
            if let code = (response as? HTTPURLResponse)?.statusCode { throw ConnectionError.http(failure?.error ?? "服务暂时无法响应", statusCode: code) }
            throw ConnectionError.message(failure?.error ?? "服务暂时无法响应")
        }
        return data
    }
    func decode<T: Decodable>(_ type: T.Type, _ path: String, method: String = "GET", body: [String: Any]? = nil, timeout: TimeInterval? = nil) async throws -> T {
        try JSONDecoder().decode(type, from: await data(path, method: method, body: body, timeout: timeout))
    }
}
