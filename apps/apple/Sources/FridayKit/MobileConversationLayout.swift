import SwiftUI

#if os(iOS)
extension View {
    func fridayMobilePageTitle(_ title: String) -> some View {
        navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(fridayString: title)
                        .font(.body.weight(.semibold))
                        .padding(.horizontal, 18).frame(height: 44)
                        .modifier(FridayMobileTitleSurface())
                        .accessibilityAddTraits(.isHeader)
                }
            }
    }
}

private struct FridayMobileTitleSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: Capsule())
        } else {
            content.background(.regularMaterial, in: Capsule())
        }
    }
}

/// The composer sits above the native tab bar in the page's safe area.
/// It no longer contains navigation buttons, a moving lens or collapse animation.
struct FridayMobileComposerDock<Composer: View>: View {
    var notice: String? = nil
    @ViewBuilder let composer: () -> Composer

    var body: some View {
        VStack(spacing: 6) {
            if let notice {
                Text(fridayString: notice)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 8)
            }
            VStack(spacing: 8) { composer() }
                .padding(8)
                .modifier(FridayMobileDockSurface(cornerRadius: 28))
        }
        .padding(.horizontal, FridayMobileDockMetrics.horizontalInset)
        .padding(.vertical, 6)
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
        .modifier(FridayMobileInputSurface(focused: focused))
        .onDisappear { focused = false }
    }
}

/// Shared upper-row sizing and fill for chat input, note search and task creation.
struct FridayMobileInputSurface: ViewModifier {
    var focused = false
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: FridayMobileDockMetrics.inputHeight / 2, style: .continuous)
        content
            .frame(minHeight: FridayMobileDockMetrics.inputHeight)
            .background(FridayTheme.conversationInput, in: shape)
            .overlay {
                if focused || contrast == .increased {
                    shape.strokeBorder(.primary.opacity(contrast == .increased ? 0.35 : 0.22), lineWidth: contrast == .increased ? 1 : 0.5)
                        .allowsHitTesting(false)
                }
            }
    }
}

struct FridayMobileTopFade: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        Group {
            if reduceTransparency {
                FridayTheme.conversationCanvas.ignoresSafeArea(.container, edges: .top).allowsHitTesting(false)
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
