import SwiftUI

extension FridayAppearance {
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

struct AppearanceSettingsView: View {
    @AppStorage(FridayPreferenceKeys.appearance) private var appearance: FridayAppearance = .system
    @AppStorage(FridayPreferenceKeys.language) private var language: FridayLanguage = .chinese

    var body: some View {
        SettingsPage(title: "外观", subtitle: "让 Friday 更合你的习惯。") {
            VStack(alignment: .leading, spacing: 16) {
                Text(friday: "界面主题").font(.system(size: 13, weight: .medium))
                HStack(spacing: 20) {
                    ForEach(FridayAppearance.allCases) { option in
                        Button { appearance = option } label: {
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
                                    .foregroundStyle(appearance == option ? .primary : .secondary)
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
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }

            SettingsGroup("语言") {
                SettingsRow("界面语言", detail: "立即生效，并在下次打开时保留。") {
                    Picker(selection: $language) {
                        ForEach(FridayLanguage.allCases) { option in
                            Text(verbatim: option.title).tag(option)
                        }
                    } label: { Text(friday: "界面语言") }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .fixedSize()
                }
            }
        }
    }
}

private struct ThemePreview: View {
    let appearance: FridayAppearance

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                preview(dark: appearance == .dark)
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
            LinearGradient(colors: dark
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
                .background(dark ? Color.white.opacity(0.035) : Color.black.opacity(0.025))
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
            .background(dark ? Color(white: 0.13) : .white)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.black.opacity(0.09)))
            .shadow(color: .black.opacity(0.12), radius: 5, y: 2)
            .padding(14)
        }
    }
}
