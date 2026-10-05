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
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
@MainActor
final class Connection {
    var server: String
    var token: String
    init() {
        server = UserDefaults.standard.string(forKey: "friday.server") ?? "http://127.0.0.1:4317"
        token = SecureToken.read(for: server) ?? ""
        #if os(macOS)
        if token.isEmpty && ["127.0.0.1", "localhost"].contains(URL(string: server)?.host ?? "") {
            let directory = ProcessInfo.processInfo.environment["FRIDAY_DATA_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/Friday"
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
    func data(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request(path, method: method, body: body))
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "服务暂时无法响应")
        }
        return data
    }
    func decode<T: Decodable>(_ type: T.Type, _ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        try JSONDecoder().decode(type, from: await data(path, method: method, body: body))
    }
}
