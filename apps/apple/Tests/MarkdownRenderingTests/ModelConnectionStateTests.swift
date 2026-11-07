import XCTest
@testable import FridayKit

final class ModelConnectionStateTests: XCTestCase {
    func testLegacyAndRemoteModelStateRemainDecodable() throws {
        let value = try JSONDecoder().decode(ModelConnectionState.self, from: Data("{\"provider\":\"DeepSeek API\",\"model\":\"deepseek-flash\",\"connected\":true}".utf8))
        XCTAssertTrue(value.connected)
        XCTAssertNil(value.baseUrl)
        XCTAssertNil(value.models)
    }

    func testProviderStateAndDiscoveryRetainModelIDsAndDisplayNames() throws {
        let models: [[String: String]] = [["id": "vendor/chat-a", "name": "Chat A"], ["id": "vendor/chat-b", "name": "Chat B"]]
        let source: [String: Any] = ["provider": "My gateway", "model": "vendor/chat-b", "connected": true, "baseUrl": "https://gateway.example/v1", "models": models]
        let data = try JSONSerialization.data(withJSONObject: source)
        let value = try JSONDecoder().decode(ModelConnectionState.self, from: data)
        XCTAssertEqual(value.baseUrl, "https://gateway.example/v1")
        XCTAssertEqual(value.models?.map(\.id), ["vendor/chat-a", "vendor/chat-b"])
        let discovery = try JSONDecoder().decode(ModelDiscoveryState.self, from: data)
        XCTAssertEqual(discovery.models.map(\.name), ["Chat A", "Chat B"])
    }
}
