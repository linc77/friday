import SwiftUI

struct TaskSidebarProjectPicker: View {
    let groups: [TaskProjectSidebar.Group]
    let selected: String?
    let select: (String?) -> Void
    let settings: (Project) -> Void
    let dismiss: () -> Void
    @State private var query = ""
    @State private var highlighted: String?
    #if os(iOS)
    @FocusState private var focused: Bool
    #endif
    private var filtered: [TaskProjectSidebar.Group] { TaskProjectSidebar.search(groups, query: query) }
    private var includesAll: Bool { query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var keys: [String] { (includesAll ? ["all"] : []) + filtered.map(\.id) }
    private var active: String? { highlighted.flatMap { keys.contains($0) ? $0 : nil } ?? keys.first }
    var body: some View {
        VStack(spacing: 0) {
            #if os(macOS)
            TaskSearchField(text: $query, move: move, submit: choose, escape: dismiss, placeholder: "搜索 Workspace…", accessibilityLabel: "搜索 Workspace", settings: editHighlighted)
                .frame(height: 28).padding(10)
            #else
            TextField(friday: "搜索 Workspace…", text: $query).textFieldStyle(.roundedBorder).focused($focused)
                .textInputAutocapitalization(.never).autocorrectionDisabled().onSubmit { _ = choose() }.padding(10)
            #endif
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        if includesAll { choice(nil).id("all") }
                        ForEach(filtered) { group in choice(group).id(group.id) }
                        if keys.isEmpty { Text(friday: "没有匹配的 Workspace").font(.callout).foregroundStyle(.secondary).padding(20) }
                    }.padding(6)
                }.frame(maxHeight: 320).scrollBounceBehavior(.basedOnSize)
                    .onChange(of: active) { _, key in if let key { proxy.scrollTo(key) } }
            }
        }.frame(width: 288)
        .onAppear { query = ""; highlighted = selected ?? "all"
            #if os(iOS)
            focused = true
            #endif
        }
        .onChange(of: query) { _, _ in highlighted = keys.first }
    }
    private func choice(_ group: TaskProjectSidebar.Group?) -> some View {
        let key = group?.id ?? "all", focused = key == active
        return HStack(spacing: 4) {
            Button { select(group?.id) } label: {
                HStack(spacing: 8) {
                    if let group, !group.scratch { WorkspaceIcon(name: group.name, icon: group.representative.icon, color: group.representative.color, size: 14) }
                    else { FridaySymbolImage(systemName: "folder").frame(width: 14) }
                    Group {
                        if let group { if group.scratch { Text(friday: "无项目") } else { Text(verbatim: group.name) } }
                        else { Text(friday: "全部 Workspace") }
                    }.lineLimit(1)
                    Spacer(minLength: 0)
                }.padding(.leading, 8).frame(maxWidth: .infinity, minHeight: 30).contentShape(Rectangle())
            }.buttonStyle(FridaySymbolButtonStyle()).accessibilityAddTraits((selected ?? "all") == key ? .isSelected : [])
            if let group, !group.scratch {
                Button { settings(group.representative) } label: { FridaySymbolImage(systemName: "gearshape").frame(width: 26, height: 28) }
                    .buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "Workspace 设置")).accessibilityLabel(Text(friday: "Workspace 设置") + Text("：\(group.name)"))
            }
        }.padding(.trailing, 4).background(focused ? Color.primary.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 6))
            .contextMenu { if let group, !group.scratch { Button(friday: "Workspace 设置") { settings(group.representative) } } }
            .onHover { if $0 { highlighted = key } }
    }
    private func move(_ delta: Int) -> Bool {
        guard !keys.isEmpty else { return false }
        let index = active.flatMap { keys.firstIndex(of: $0) } ?? 0
        highlighted = keys[(index + delta + keys.count) % keys.count]; return true
    }
    private func choose() -> Bool { guard let key = active else { return false }; select(key == "all" ? nil : key); return true }
    private func editHighlighted() { if let group = groups.first(where: { $0.id == active }), !group.scratch { settings(group.representative) } }
}
