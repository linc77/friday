import SwiftUI

extension WorkspaceStyle {
    static func tint(_ value: String) -> Color {
        switch value {
        case "blue": .blue
        case "teal": .teal
        case "green": .green
        case "yellow": .yellow
        case "orange": .orange
        case "pink": .pink
        case "purple": .purple
        default: .gray
        }
    }
}

struct WorkspaceIcon: View {
    let name: String
    var icon: String? = nil
    var color: String? = nil
    var size: CGFloat = 16

    private var tint: Color { WorkspaceStyle.tint(WorkspaceStyle.color(color, name: name)) }

    var body: some View {
        FridaySymbolImage(systemName: WorkspaceStyle.icon(icon))
            .font(.system(size: size * 0.6, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.25))
            .accessibilityHidden(true)
    }
}

struct WorkspaceAppearancePicker: View {
    @Binding var icon: String
    @Binding var color: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(friday: "图标").font(.callout.weight(.medium))
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 6), spacing: 6) {
                ForEach(Array(WorkspaceStyle.icons.enumerated()), id: \.element) { index, value in
                    Button { icon = value } label: {
                        FridaySymbolImage(systemName: value)
                            .font(.system(size: 16))
                            .foregroundStyle(icon == value ? WorkspaceStyle.tint(color) : .secondary)
                            .frame(maxWidth: .infinity).frame(height: 34)
                            .background(icon == value ? WorkspaceStyle.tint(color).opacity(0.12) : Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 7))
                            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(icon == value ? WorkspaceStyle.tint(color) : .clear))
                            .contentShape(Rectangle())
                    }.buttonStyle(FridaySymbolButtonStyle())
                        .accessibilityLabel(Text(fridayString: WorkspaceStyle.iconLabels[index]))
                        .accessibilityAddTraits(icon == value ? .isSelected : [])
                        .help(Text(fridayString: WorkspaceStyle.iconLabels[index]))
                }
            }
            Text(friday: "颜色").font(.callout.weight(.medium)).padding(.top, 4)
            HStack(spacing: 8) {
                ForEach(Array(WorkspaceStyle.colors.enumerated()), id: \.element) { index, value in
                    Button { color = value } label: {
                        ZStack {
                            Circle().fill(WorkspaceStyle.tint(value))
                            if color == value {
                                FridaySymbolImage(systemName: "checkmark")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(value == "yellow" ? Color.black : Color.white)
                            }
                        }.frame(width: 26, height: 26).contentShape(Circle())
                    }.buttonStyle(FridaySymbolButtonStyle())
                        .accessibilityLabel(Text(fridayString: WorkspaceStyle.colorLabels[index]))
                        .accessibilityAddTraits(color == value ? .isSelected : [])
                        .help(Text(fridayString: WorkspaceStyle.colorLabels[index]))
                }
            }
        }.frame(maxWidth: 300, alignment: .leading)
    }
}

struct WorkspaceIdentityEditor: View {
    @ObservedObject var store: FridayStore
    let project: Project
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var icon: String
    @State private var color: String
    @State private var busy = false
    @State private var error: String?

    init(store: FridayStore, project: Project) {
        self.store = store; self.project = project
        _name = State(initialValue: project.name)
        _icon = State(initialValue: WorkspaceStyle.icon(project.icon))
        _color = State(initialValue: WorkspaceStyle.color(project.color, name: project.name))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(friday: "编辑 Workspace").font(.headline)
            HStack(spacing: 12) {
                WorkspaceIcon(name: name, icon: icon, color: color, size: 40)
                Text(name.isEmpty ? project.name : name).font(.title3.weight(.medium)).lineLimit(1)
            }
            TextField(friday: "Workspace 名称", text: $name).textFieldStyle(.roundedBorder)
                .accessibilityLabel(Text(friday: "Workspace 名称"))
            WorkspaceAppearancePicker(icon: $icon, color: $color)
            if name.utf16.count > 120 { Text(friday: "名称最多 120 个字符").font(.caption).foregroundStyle(.orange) }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Button(friday: "取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(friday: "保存修改", action: save)
                    .buttonStyle(FridayButtonStyle(prominent: true, compact: true))
                    .keyboardShortcut(.defaultAction)
                    .disabled(!WorkspaceStyle.validName(name) || !store.connected)
            }
        }
        .padding(20).frame(width: 320).disabled(busy).interactiveDismissDisabled(busy)
    }

    private func save() {
        guard !busy, WorkspaceStyle.validName(name), store.connected else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await store.connection.data("/api/projects/\(project.id)", method: "PUT", body: ["name": name, "icon": icon, "color": color])
                await store.refresh()
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
