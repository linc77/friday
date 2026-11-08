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
    var flexibleHeight = false
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
        #if os(iOS)
        mobileContent
            .onChange(of: scope) { _, _ in dismiss() }
        #else
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
        .frame(width: 460, height: flexibleHeight ? nil : 380)
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
        #endif
    }

    #if os(iOS)
    private var mobileContent: some View {
        NavigationStack {
            List {
                ForEach(instances.filter { lockedProvider == nil || $0.driver == lockedProvider }) { instance in
                    let models = choices.filter { $0.selectionId == instance.id }
                    if !models.isEmpty {
                        Section {
                            ForEach(models) { choice in modelRow(choice) }
                        } header: {
                            HStack(spacing: 8) {
                                AgentProviderIcon(provider: instance.driver, size: 18)
                                Text(instance.name)
                            }
                        }
                    }
                }
                if choices.isEmpty {
                    Text(friday: "没有匹配的模型").foregroundStyle(.secondary)
                }
            }
            .searchable(text: $search, prompt: Text(friday: "搜索模型…"))
            .navigationTitle(Text(friday: "任务模型"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(friday: "完成") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }
    #endif

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

#if os(iOS)
private struct MobileNewTaskModelKey: EnvironmentKey {
    static let defaultValue: Binding<TaskModelChoice?>? = nil
}

extension EnvironmentValues {
    var mobileNewTaskModel: Binding<TaskModelChoice?>? {
        get { self[MobileNewTaskModelKey.self] }
        set { self[MobileNewTaskModelKey.self] = newValue }
    }
}

struct MobileTaskModelControl: View {
    @Bindable var store: FridayStore
    @Binding var selection: TaskModelChoice?
    @State private var showing = false
    @State private var states: [String: CodexConnectionState] = [:]
    @State private var failure: String?
    @State private var loading = false

    var body: some View {
        Button { showing = true } label: {
            HStack(spacing: 6) {
                AgentProviderIcon(provider: selection?.provider ?? "codex", size: 20)
                FridaySymbolImage(systemName: "chevron.down").font(.caption2)
            }
            .frame(minWidth: 56, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(FridaySymbolButtonStyle())
        .accessibilityLabel(Text(friday: "任务模型"))
        .accessibilityValue(Text(selection?.model.selectionName ?? "Codex"))
        .sheet(isPresented: $showing) {
            TaskModelPicker(server: store.connection.server, scope: store.connectionIdentity,
                states: states, lockedProvider: nil, provider: selection?.provider ?? "codex",
                model: selection?.model.id ?? "", instances: store.providerInstances,
                instanceId: selection?.selectionId) { choice in
                    selection = choice
                    showing = false
                }
                .safeAreaInset(edge: .bottom) {
                    if loading { Text(friday: "正在加载…").font(.caption).padding(8) }
                    if let failure { Text(verbatim: failure).font(.caption).foregroundStyle(.secondary).padding(8) }
                }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .task(id: store.connectionIdentity + ":" + String(store.connected) + ":" + String(showing)) {
            states = [:]; failure = nil; loading = false
            guard store.connected else { return }
            let identity = store.connectionIdentity
            let connection = store.connection
            loading = true
            defer { if store.connectionIdentity == identity { loading = false } }
            await store.loadProviderInstances()
            guard !Task.isCancelled, store.connectionIdentity == identity else { return }
            for instance in store.providerInstances {
                do {
                    var state = try await connection.decode(CodexConnectionState.self, TaskProviderCatalog.endpoint(instance.driver, instance: instance.id))
                    guard !Task.isCancelled, store.connectionIdentity == identity else { return }
                    if !instance.enabled { state.enabled = false; state.connected = false }
                    states[instance.id] = state
                } catch {
                    guard !Task.isCancelled, store.connectionIdentity == identity else { return }
                    failure = error.localizedDescription
                }
            }
            if selection == nil,
               let instance = store.providerInstances.first(where: { $0.enabled && states[$0.id]?.connected == true }),
               let models = states[instance.id]?.models,
               let model = models.first(where: { $0.isDefault }) ?? models.first {
                selection = TaskModelChoice(provider: instance.driver, model: model, instanceId: instance.id, instanceName: instance.name)
            }
        }
        .onChange(of: store.connectionIdentity) { _, _ in selection = nil; showing = false }
    }
}
#endif
