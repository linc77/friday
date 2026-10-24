import SwiftUI

struct TaskModelChoice: Identifiable {
    let provider: String
    let model: CodexProviderModel
    var instanceId: String? = nil
    var instanceName: String? = nil
    var selectionId: String { instanceId ?? provider }
    var id: String { selectionId + ":" + model.id }
    var providerName: String { instanceName ?? TaskProviderCatalog.name(provider) }
}

struct TaskModelPicker: View {
    let server: String
    let scope: String
    let states: [String: CodexConnectionState]
    let lockedProvider: String?
    let provider: String
    let model: String
    var instances: [ProviderInstanceInfo] = ProviderInstanceInfo.defaults
    var instanceId: String? = nil
    var lockedInstance: String? = nil
    let select: (TaskModelChoice) -> Void
    @ObservedObject private var preferences = ProviderModelPreferences.shared
    @State private var search = ""
    @State private var filter = "all"
    @FocusState private var searching: Bool
    @Environment(\.dismiss) private var dismiss
    #if os(macOS)
    @Environment(\.fridayModelJump) private var modelJump
    @State private var jumpOwner = UUID()
    #endif

    private var choices: [TaskModelChoice] {
        instances.filter { (lockedProvider == nil || $0.driver == lockedProvider) && (lockedInstance == nil || $0.id == lockedInstance) }.flatMap { value in
            preferences.get(server: server, provider: value.id).sorted(states[value.id]?.models ?? [], includeHidden: false)
                .map { TaskModelChoice(provider: value.driver, model: $0, instanceId: value.id, instanceName: value.name) }
        }.filter { choice in
            (filter == "all" || filter == choice.selectionId || (filter == "favorites" && favorite(choice))) &&
            (search.isEmpty || [choice.model.name, choice.model.id, choice.model.resolvedModel ?? "", choice.providerName].contains { $0.localizedCaseInsensitiveContains(search) })
        }
    }
    private func favorite(_ choice: TaskModelChoice) -> Bool {
        preferences.get(server: server, provider: choice.selectionId).favorites.contains(choice.model.id)
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 8) {
                filterButton("all", title: "全部模型", symbol: "square.stack")
                filterButton("favorites", title: "收藏", symbol: "star")
                Divider().padding(.horizontal, 8)
                ForEach(instances.filter { states[$0.id] != nil && (lockedProvider == nil || lockedProvider == $0.driver) && (lockedInstance == nil || lockedInstance == $0.id) }) { value in
                    filterButton(value.id, title: LocalizedStringKey(value.name))
                }
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
        .onChange(of: scope) { _, _ in dismiss() }
        #if os(macOS)
        .onAppear { installJumpContext() }
        .onChange(of: choices.map { $0.id + ":" + String(states[$0.selectionId]?.connected == true) }) { _, _ in
            if modelJump.wrappedValue?.owner == jumpOwner { installJumpContext() }
        }
        .onDisappear { if modelJump.wrappedValue?.owner == jumpOwner { modelJump.wrappedValue = nil } }
        .onExitCommand { dismiss() }
        #endif
    }

    #if os(macOS)
    private func installJumpContext() {
        let models = Array(choices.prefix(9))
        let revision = UUID()
        let enabled = Set(models.indices.filter { states[models[$0].selectionId]?.connected == true })
        modelJump.wrappedValue = TaskModelJumpContext(owner: jumpOwner, revision: revision, titles: models.map { $0.providerName + " · " + $0.model.selectionName }, enabled: enabled) { index in
            guard enabled.contains(index), modelJump.wrappedValue?.owner == jumpOwner, modelJump.wrappedValue?.revision == revision else { return }
            modelJump.wrappedValue = nil; select(models[index])
        }
    }
    #endif

    private func filterButton(_ value: String, title: LocalizedStringKey, symbol: String? = nil) -> some View {
        Button { filter = value } label: {
            Group {
                if let symbol {
                    FridaySymbolImage(systemName: symbol).font(.system(size: 17, weight: .regular))
                } else {
                    AgentProviderIcon(provider: instances.first(where: { $0.id == value })?.driver ?? value, size: 22).foregroundStyle(.primary)
                }
            }
                .frame(width: 36, height: 36).foregroundStyle(filter == value ? FridayTheme.accent : .secondary)
                .background(filter == value ? FridayTheme.accent.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 8))
        }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: title)).help(Text(friday: title))
            .accessibilityAddTraits(filter == value ? .isSelected : [])
    }

    private func modelRow(_ choice: TaskModelChoice) -> some View {
        let selected = (instanceId ?? provider) == choice.selectionId && model == choice.model.id
        let available = states[choice.selectionId]?.connected == true
        return HStack(spacing: 8) {
            Button { select(choice) } label: {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(choice.model.selectionName).font(.callout).lineLimit(2)
                        HStack(spacing: 4) {
                            AgentProviderIcon(provider: choice.provider, size: 12)
                            if let color = instances.first(where: { $0.id == choice.selectionId })?.accent { Circle().fill(color).frame(width: 5, height: 5).accessibilityHidden(true) }
                            Text(choice.providerName)
                            if !available { Text("·"); Text(friday: "未连接") }
                        }.font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    #if os(macOS)
                    if let index = choices.firstIndex(where: { $0.id == choice.id }), index < 9 {
                        Text("⌘\(index + 1)").font(.caption2.monospaced()).foregroundStyle(.tertiary).accessibilityHidden(true)
                    }
                    #endif
                    if selected { FridaySymbolImage(systemName: "checkmark").font(.caption).foregroundStyle(FridayTheme.accent) }
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(FridaySymbolButtonStyle()).disabled(!available)
            Button {
                preferences.update(server: server, provider: choice.selectionId) { value in
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
