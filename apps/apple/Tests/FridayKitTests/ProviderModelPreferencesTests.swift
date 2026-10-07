import Foundation

@main
struct ProviderModelPreferencesTests {
    @MainActor static func main() throws {
        let suite = "dev.friday.model-preferences-tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ProviderModelPreferences(defaults: defaults)
        let models = ["a", "b", "c"].map {
            CodexProviderModel(id: $0, name: $0, description: "", isDefault: $0 == "a", reasoningEfforts: [], defaultReasoningEffort: "")
        }
        preferences.update(server: "http://host:4317/", provider: "codex") {
            $0.favorites = ["c"]; $0.hidden = ["b"]; $0.order = ["b", "a", "c"]
        }
        let restored = ProviderModelPreferences(defaults: defaults)
        let saved = restored.get(server: "http://host:4317", provider: "codex")
        precondition(saved.sorted(models).map(\.id) == ["c", "b", "a"], "Favorites lead explicit model order")
        precondition(saved.sorted(models, includeHidden: false).map(\.id) == ["c", "a"], "Hidden models leave the picker")
        precondition(restored.get(server: "http://host:4317", provider: "claude").favorites.isEmpty)
        precondition(restored.get(server: "http://other:4317", provider: "codex").hidden.isEmpty)
        let fresh = CodexProviderModel(id: "new", name: "New", description: "", isDefault: false, reasoningEfforts: [], defaultReasoningEffort: "")
        precondition(saved.sorted(models + [fresh]).map(\.id) == ["c", "b", "a", "new"], "Newly discovered models remain visible")
        let oldSettings = Data("""
        {"enabled":true,"displayName":"Codex","binaryPath":"codex","homePath":"","shadowHomePath":"","launchArgs":"","model":"","reasoningEffort":"","environment":[]}
        """.utf8)
        var settings = try JSONDecoder().decode(CodexProviderSettings.self, from: oldSettings)
        precondition(settings.customModels.isEmpty, "Existing service settings still decode")
        precondition(settings.permissionMode == "auto", "Existing settings default to Auto")
        settings.permissionMode = "default"
        settings.customModels.append(CustomProviderModel(id: "gateway/custom", name: "Custom"))
        let decoded = try JSONDecoder().decode(CodexProviderSettings.self, from: JSONEncoder().encode(settings))
        precondition(decoded.customModels == settings.customModels)
        precondition(decoded.permissionMode == "default")
        precondition(settings.body["permissionMode"] as? String == "default", "Settings writes include the chosen mode")
        print("Model favorites, visibility, order, host isolation, and settings compatibility passed")
    }
}
