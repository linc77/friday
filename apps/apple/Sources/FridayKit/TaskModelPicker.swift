import SwiftUI

struct TaskModelChoice: Identifiable {
    let provider: String
    let model: CodexProviderModel
    var id: String { provider + ":" + model.id }
    var providerName: String { provider == "claude" ? "Claude" : "Codex" }
}

struct TaskModelPicker: View {
    let server: String
    let states: [String: CodexConnectionState]
    let lockedProvider: String?
    let provider: String
    let model: String
    let select: (TaskModelChoice) -> Void
    @ObservedObject private var preferences = ProviderModelPreferences.shared
    @State private var search = ""
    @State private var filter = "all"
    @FocusState private var searching: Bool

    private var choices: [TaskModelChoice] {
        ["codex", "claude"].filter { lockedProvider == nil || $0 == lockedProvider }.flatMap { value in
            preferences.get(server: server, provider: value).sorted(states[value]?.models ?? [], includeHidden: false)
                .map { TaskModelChoice(provider: value, model: $0) }
        }.filter { choice in
            (filter == "all" || filter == choice.provider || (filter == "favorites" && favorite(choice))) &&
            (search.isEmpty || [choice.model.name, choice.model.id, choice.model.resolvedModel ?? "", choice.providerName].contains { $0.localizedCaseInsensitiveContains(search) })
        }
    }
    private func favorite(_ choice: TaskModelChoice) -> Bool {
        preferences.get(server: server, provider: choice.provider).favorites.contains(choice.model.id)
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 8) {
                filterButton("all", title: "全部模型", symbol: "square.stack")
                filterButton("favorites", title: "收藏", symbol: "star")
                Divider().padding(.horizontal, 8)
                if lockedProvider == nil || lockedProvider == "codex" { filterButton("codex", title: "Codex") }
                if lockedProvider == nil || lockedProvider == "claude" { filterButton("claude", title: "Claude") }
                Spacer()
            }.padding(8).frame(width: 54)
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    FridaySymbolImage(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField(friday: "搜索模型…", text: $search).textFieldStyle(.plain).focused($searching)
                }.padding(14)
                Divider()
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(choices) { choice in modelRow(choice) }
                        if choices.isEmpty { Text(friday: "没有匹配的模型").foregroundStyle(.secondary).padding(24) }
                    }.padding(8)
                }
                if lockedProvider != nil {
                    Divider()
                    Text(friday: "续聊保留当前 Agent 和会话。")
                        .font(.caption).foregroundStyle(.secondary).padding(12)
                }
            }
        }
        #if os(macOS)
        .frame(width: 460, height: 380)
        #else
        .frame(width: 340, height: 380)
        #endif
        .task { searching = true }
    }

    private func filterButton(_ value: String, title: LocalizedStringKey, symbol: String? = nil) -> some View {
        Button { filter = value } label: {
            Group {
                if let symbol {
                    FridaySymbolImage(systemName: symbol).font(.system(size: 17, weight: .regular))
                } else {
                    AgentProviderIcon(provider: value, size: 22).foregroundStyle(.primary)
                }
            }
                .frame(width: 36, height: 36).foregroundStyle(filter == value ? FridayTheme.accent : .secondary)
                .background(filter == value ? FridayTheme.accent.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 8))
        }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: title)).help(Text(friday: title))
            .accessibilityAddTraits(filter == value ? .isSelected : [])
    }

    private func modelRow(_ choice: TaskModelChoice) -> some View {
        let selected = provider == choice.provider && model == choice.model.id
        let available = states[choice.provider]?.connected == true
        return HStack(spacing: 8) {
            Button { select(choice) } label: {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(choice.model.selectionName).font(.callout).lineLimit(2)
                        HStack(spacing: 4) {
                            AgentProviderIcon(provider: choice.provider, size: 12)
                            Text(choice.providerName)
                            if !available { Text("·"); Text(friday: "未连接") }
                        }.font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    if selected { FridaySymbolImage(systemName: "checkmark").font(.caption).foregroundStyle(FridayTheme.accent) }
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(FridaySymbolButtonStyle()).disabled(!available)
            Button {
                preferences.update(server: server, provider: choice.provider) { value in
                    if value.favorites.contains(choice.model.id) { value.favorites.removeAll { $0 == choice.model.id } }
                    else { value.favorites.append(choice.model.id) }
                }
            } label: {
                FridaySymbolImage(systemName: favorite(choice) ? "star.fill" : "star")
                    .foregroundStyle(favorite(choice) ? .orange : .secondary).frame(width: 26, height: 30)
            }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: favorite(choice) ? "取消收藏" : "收藏模型"))
        }.padding(.horizontal, 10).padding(.vertical, 8)
            .background(selected ? Color.primary.opacity(0.06) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
    }
}
