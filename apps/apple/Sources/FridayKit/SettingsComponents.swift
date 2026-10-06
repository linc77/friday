import SwiftUI

struct SettingsPage<Content: View>: View {
    let title: String
    let subtitle: String
    private let content: Content

    init(title: String, subtitle: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(fridayString: title).font(.system(size: 26, weight: .semibold))
                    Text(fridayString: subtitle).font(.system(size: 13)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.bottom, 8)
                content
            }
            .frame(maxWidth: 680, alignment: .leading)
            #if os(macOS)
            .padding(.horizontal, 36)
            .padding(.top, 52)
            #else
            .padding(.horizontal, 20)
            .padding(.top, 24)
            #endif
            .padding(.bottom, 48)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(FridayTheme.surface)
    }
}

struct SettingsGroup<Content: View>: View {
    let title: String
    private let content: Content
    @Environment(\.colorSchemeContrast) private var contrast

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(fridayString: title).font(.system(size: 13, weight: .medium))
            VStack(alignment: .leading, spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(FridayTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay {
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(.primary.opacity(contrast == .increased ? 0.25 : 0.075))
                        .allowsHitTesting(false)
                }
        }
    }
}

struct SettingsRow<Control: View>: View {
    private let title: Text
    let detail: String?
    private let control: Control

    init(_ title: String, detail: String? = nil, @ViewBuilder control: () -> Control) {
        self.title = Text(fridayString: title)
        self.detail = detail
        self.control = control()
    }

    init(verbatim title: String, detail: String? = nil, @ViewBuilder control: () -> Control) {
        self.title = Text(verbatim: title)
        self.detail = detail
        self.control = control()
    }

    private var layout: AnyLayout {
        #if os(macOS)
        AnyLayout(HStackLayout(alignment: .center, spacing: 20))
        #else
        AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
        #endif
    }

    var body: some View {
        layout {
            VStack(alignment: .leading, spacing: 4) {
                title.font(.system(size: 13, weight: .medium))
                if let detail {
                    Text(fridayString: detail).font(.system(size: 12)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            control.controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

struct SettingsDivider: View {
    var body: some View {
        Divider().overlay(FridayTheme.surface.opacity(0.45)).padding(.horizontal, 16)
    }
}
