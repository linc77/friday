import Foundation
import Combine

struct ModelPickerPreferences: Codable, Equatable {
    var favorites: [String] = []
    var hidden: [String] = []
    var order: [String] = []

    func sorted(_ models: [CodexProviderModel], includeHidden: Bool = true) -> [CodexProviderModel] {
        let positions = Dictionary(order.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { first, _ in first })
        return models.enumerated().filter { includeHidden || !hidden.contains($0.element.id) }.sorted { left, right in
            let leftFavorite = favorites.contains(left.element.id), rightFavorite = favorites.contains(right.element.id)
            if leftFavorite != rightFavorite { return leftFavorite }
            return (positions[left.element.id] ?? (order.count + left.offset)) < (positions[right.element.id] ?? (order.count + right.offset))
        }.map(\.element)
    }
}

@MainActor
final class ProviderModelPreferences: ObservableObject {
    static let shared = ProviderModelPreferences()
    @Published private var values: [String: ModelPickerPreferences]
    private let defaults: UserDefaults
    private let key = "friday.provider-model-preferences"
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        values = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([String: ModelPickerPreferences].self, from: $0) } ?? [:]
    }
    private func scope(_ server: String, _ provider: String) -> String {
        server.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "|" + provider
    }
    func get(server: String, provider: String) -> ModelPickerPreferences {
        values[scope(server, provider)] ?? ModelPickerPreferences()
    }
    func update(server: String, provider: String, _ change: (inout ModelPickerPreferences) -> Void) {
        let scope = scope(server, provider)
        var value = values[scope] ?? ModelPickerPreferences(); change(&value); values[scope] = value
        if let data = try? JSONEncoder().encode(values) { defaults.set(data, forKey: key) }
    }
}
