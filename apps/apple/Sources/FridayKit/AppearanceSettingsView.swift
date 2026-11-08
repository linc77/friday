import SwiftUI

extension FridayAppearance {
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark, .midnight: .dark
        }
    }
}

struct AppearanceSettingsView: View {
    @FridayPreference(FridayPreferenceKeys.appearance) private var appearance: FridayAppearance = .system

    var body: some View {
        SettingsPage(title: "外观", subtitle: "调整主题、Friday 形象、字体、内容宽度和代码配色。") {
            VStack(alignment: .leading, spacing: 16) {
                Text(friday: "界面主题").font(.system(size: 13, weight: .medium))
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 145), spacing: 16)], spacing: 20) {
                    ForEach(FridayAppearance.allCases) { option in
                        Button { appearance = option; FridayPalette.shared.appearance = option } label: {
                            VStack(spacing: 12) {
                                ThemePreview(appearance: option)
                                    .frame(height: 112)
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                    .padding(4)
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 16)
                                            .strokeBorder(appearance == option ? FridayTheme.accent : .clear, lineWidth: 2)
                                    }
                                Text(fridayString: option.title)
                                    .font(.system(size: 13, weight: appearance == option ? .semibold : .regular))
                                    .foregroundStyle(appearance == option ? FridayTheme.foreground : FridayTheme.secondaryText)
                            }
                            .frame(maxWidth: .infinity)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(FridaySymbolButtonStyle())
                        .accessibilityLabel(Text(fridayString: option.title))
                        .accessibilityAddTraits(appearance == option ? .isSelected : [])
                    }
                }
                Text(friday: "选择“系统”时，外观会跟随系统的浅色或深色模式。")
                    .font(.system(size: 12)).foregroundStyle(FridayTheme.secondaryText)
            }
            FridayAvatarSettings()
            ReadingAppearanceControls()

        }
    }
}

private struct FridayAvatarSettings: View {
    @FridayPreference(FridayPreferenceKeys.avatarBodyColor) private var bodyColor = FridayAvatarColor.bodyDefault
    @FridayPreference(FridayPreferenceKeys.avatarEyeColor) private var eyeColor = FridayAvatarColor.eyeDefault
    @FridayPreference(FridayPreferenceKeys.avatarBowTieColor) private var bowTieColor = FridayAvatarColor.bowTieDefault

    var body: some View {
        SettingsGroup("Friday 形象") {
            HStack(spacing: 16) {
                FridayMark(size: 72)
                    .frame(width: 88, height: 88)
                    .background(FridayTheme.canvas, in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text(friday: "当前形象")
                        .font(.system(size: 13, weight: .medium))
                    Text(friday: "颜色会立即应用到对话中的 Friday。")
                        .font(.system(size: 12))
                        .foregroundStyle(FridayTheme.secondaryText)
                    Button(friday: "恢复形象默认颜色") {
                        bodyColor = FridayAvatarColor.bodyDefault
                        eyeColor = FridayAvatarColor.eyeDefault
                        bowTieColor = FridayAvatarColor.bowTieDefault
                    }
                    .buttonStyle(FridayButtonStyle(compact: true))
                    .padding(.top, 4)
                }
                Spacer(minLength: 0)
            }
            .padding(16)
            SettingsDivider()
            FridayAvatarColorRow(title: "球体", hex: $bodyColor, defaultHex: FridayAvatarColor.bodyDefault)
            SettingsDivider()
            FridayAvatarColorRow(title: "眼睛", hex: $eyeColor, defaultHex: FridayAvatarColor.eyeDefault)
            SettingsDivider()
            FridayAvatarColorRow(title: "领结", hex: $bowTieColor, defaultHex: FridayAvatarColor.bowTieDefault)
        }
        .onAppear {
            // The first palette used a near-black swatch and dark gray defaults.
            if bodyColor == "101116" { bodyColor = "000000" }
            if eyeColor == "252525" { eyeColor = "000000" }
            if bowTieColor == "202020" { bowTieColor = "000000" }
        }
    }
}

private struct FridayAvatarColorRow: View {
    let title: String
    @Binding var hex: String
    let defaultHex: String

    private struct Preset: Identifiable {
        let name: String
        let hex: String
        var id: String { hex }
    }

    private let presets: [Preset] = [
        .init(name: "蓝色", hex: FridayAvatarColor.bodyDefault),
        .init(name: "白色", hex: "FFFFFF"),
        .init(name: "黑色", hex: "000000"),
        .init(name: "红色", hex: "EF4562"),
        .init(name: "橙色", hex: "FF8A35"),
        .init(name: "黄色", hex: "F5C84B"),
        .init(name: "绿色", hex: "44C788"),
        .init(name: "青色", hex: "36C9CF"),
        .init(name: "紫色", hex: "9275E9"),
        .init(name: "粉色", hex: "F27CB3")
    ]

    private var selectedColor: Binding<Color> {
        Binding(get: { (FridayAvatarColor(hex: hex) ?? FridayAvatarColor(hex: defaultHex)!).color },
                set: { hex = FridayAvatarColor.hex(for: $0) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(fridayString: title).font(FridayTheme.interfaceFont)
            HStack(spacing: 12) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 5) {
                        ForEach(presets) { preset in
                            Button { hex = preset.hex } label: {
                                Circle()
                                    .fill((FridayAvatarColor(hex: preset.hex) ?? .black).color)
                                    .frame(width: 22, height: 22)
                                    .padding(11)
                                    .overlay {
                                        Circle().strokeBorder(hex.uppercased() == preset.hex ? FridayTheme.accent : FridayTheme.separator,
                                                              lineWidth: hex.uppercased() == preset.hex ? 2 : 1)
                                    }
                                    .contentShape(Circle())
                            }
                            .buttonStyle(FridaySymbolButtonStyle())
                            .accessibilityLabel(Text(fridayString: title) + Text("，") + Text(fridayString: preset.name))
                            .accessibilityAddTraits(hex.uppercased() == preset.hex ? .isSelected : [])
                        }
                    }
                }
                ColorPicker("自定义颜色", selection: selectedColor, supportsOpacity: false)
                    .labelsHidden()
                    .frame(width: 30)
                    .fridayInteractiveCursor()
                    .accessibilityLabel(Text(friday: "自定义颜色"))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

private struct ThemePreview: View {
    let appearance: FridayAppearance

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                preview(dark: appearance == .dark || appearance == .midnight)
                if appearance == .system {
                    preview(dark: true)
                        .mask(alignment: .trailing) {
                            Rectangle().frame(width: geometry.size.width / 2)
                        }
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func preview(dark: Bool) -> some View {
        ZStack {
            LinearGradient(colors: appearance == .midnight
                ? [FridayTheme.color(0x3c3e4c), FridayTheme.color(0x121420)]
                : dark
                ? [Color(red: 0.36, green: 0.40, blue: 0.48), Color(red: 0.15, green: 0.17, blue: 0.21)]
                : [Color(red: 0.91, green: 0.85, blue: 0.74), Color(red: 0.76, green: 0.66, blue: 0.58)],
                startPoint: .topLeading, endPoint: .bottomTrailing)
            HStack(spacing: 0) {
                VStack(spacing: 9) {
                    FridaySymbolImage(systemName: FridaySymbols.chat)
                    FridaySymbolImage(systemName: "checklist")
                    FridaySymbolImage(systemName: "gearshape")
                }
                .font(.system(size: 8, weight: .regular))
                .foregroundStyle(dark ? Color.white.opacity(0.5) : Color.black.opacity(0.35))
                .frame(width: 24)
                .frame(maxHeight: .infinity)
                .background(appearance == .midnight ? FridayTheme.color(0x121420) : dark ? Color.white.opacity(0.035) : Color.black.opacity(0.025))
                VStack(alignment: .leading, spacing: 7) {
                    RoundedRectangle(cornerRadius: 2).fill(dark ? .white.opacity(0.7) : .black.opacity(0.6))
                        .frame(width: 28, height: 4)
                    RoundedRectangle(cornerRadius: 2).fill(.gray.opacity(0.25)).frame(height: 3)
                    RoundedRectangle(cornerRadius: 2).fill(.gray.opacity(0.2)).frame(height: 3)
                    RoundedRectangle(cornerRadius: 2).fill(.gray.opacity(0.15)).frame(width: 30, height: 3)
                }
                .padding(12)
            }
            .frame(maxWidth: 116, maxHeight: 76)
            .background(appearance == .midnight ? FridayTheme.color(0x1c1e27) : dark ? Color(white: 0.13) : .white)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.black.opacity(0.09)))
            .shadow(color: .black.opacity(0.12), radius: 5, y: 2)
            .padding(14)
        }
    }
}
