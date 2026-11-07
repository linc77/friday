import SwiftUI

#if os(iOS)
private struct FridayMobileTabSelectionKey: EnvironmentKey {
    static let defaultValue: Binding<Int>? = nil
}

private struct FridayMobileNewConversationKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var fridayMobileTabSelection: Binding<Int>? {
        get { self[FridayMobileTabSelectionKey.self] }
        set { self[FridayMobileTabSelectionKey.self] = newValue }
    }

    var fridayMobileNewConversation: (() -> Void)? {
        get { self[FridayMobileNewConversationKey.self] }
        set { self[FridayMobileNewConversationKey.self] = newValue }
    }
}

extension View {
    /// Retain each section's navigation and drafts without creating a system tab bar.
    func fridayMobilePage(isSelected: Bool) -> some View {
        opacity(isSelected ? 1 : 0)
            .zIndex(isSelected ? 1 : 0)
            .allowsHitTesting(isSelected)
            .disabled(!isSelected)
            .accessibilityHidden(!isSelected)
            .environment(\.fridayMobilePageIsSelected, isSelected)
    }
}

/// Only the composer follows the keyboard; navigation belongs to each home page.
struct FridayMobileComposerDock<Composer: View>: View {
    @ViewBuilder let composer: () -> Composer

    var body: some View {
        VStack(spacing: 8) {
            composer()
        }
        .padding(8)
        .modifier(FridayMobileDockSurface(cornerRadius: 28))
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }
}

struct FridayMobileComposer: View {
    @Binding var message: String
    let placeholder: String
    let sending: Bool
    let disabled: Bool
    let send: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(friday: placeholder, text: $message, axis: .vertical)
                .font(.body)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .focused($focused)
                .accessibilityLabel(Text(friday: "告诉 Friday 你想做什么"))
                .padding(.vertical, 12)
                .padding(.leading, 16)
            Button(action: send) {
                ZStack {
                    Circle().fill(FridayTheme.accent.opacity(disabled ? 0.12 : 1))
                    if sending {
                        ProgressView().tint(FridayTheme.onAccent).controlSize(.small)
                    } else {
                        FridaySymbolImage(systemName: "arrow.up")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(disabled ? Color.secondary : FridayTheme.onAccent)
                    }
                }
                .frame(width: 32, height: 32)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(FridaySymbolButtonStyle())
            .accessibilityLabel(Text(friday: sending ? "发送中" : "发送"))
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(disabled)
        }
        .background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 22))
        .overlay {
            RoundedRectangle(cornerRadius: 22)
                .strokeBorder(.primary.opacity(focused ? 0.22 : 0.09), lineWidth: 0.5)
                .allowsHitTesting(false)
        }
        .onDisappear { focused = false }
    }
}

struct FridayMobileTopFade: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        Group {
            if reduceTransparency {
                FridayTheme.canvas.ignoresSafeArea(.container, edges: .top).allowsHitTesting(false)
            } else {
                Rectangle().fill(.regularMaterial)
                    .mask {
                        LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.5), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom)
                    }
                    .ignoresSafeArea(.container, edges: .top)
                    .allowsHitTesting(false)
            }
        }
        .frame(height: 24)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
#endif
