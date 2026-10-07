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
    }
}

/// A single floating surface for writing and switching sections.
struct FridayMobileDock<Composer: View>: View {
    @Environment(\.fridayMobileTabSelection) private var selection
    @Environment(\.fridayMobileNewConversation) private var newConversation
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Namespace private var glassNamespace
    @GestureState private var trackingDrag = false
    @State private var tabDrag = FridayMobileTabDrag()
    @ViewBuilder let composer: () -> Composer
    private let sections: [FridaySection] = [.chat, .inbox, .tasks, .settings]

    var body: some View {
        surface
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 6)
    }

    @ViewBuilder private var surface: some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *), !reduceTransparency, contrast != .increased {
            // Render the panel and moving lens together, sampling the page once.
            GlassEffectContainer(spacing: 0) {
                dockContent
                    .padding(10)
                    .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 32))
            }
        } else {
            dockContent.padding(10).fridayFloatingSurface()
        }
        #else
        dockContent.padding(10).fridayFloatingSurface()
        #endif
    }

    private var dockContent: some View {
        VStack(spacing: 8) {
            composer()
            if let selection {
                navigationRow(selection: selection)
            }
        }
    }

    private func navigationRow(selection: Binding<Int>) -> some View {
        GeometryReader { geometry in
            let layout = FridayMobileTabLayout(width: geometry.size.width, count: sections.count)
            let previewIndex = tabDrag.location.map { layout.index(at: $0.x) } ?? selection.wrappedValue
            let lensCenter = tabDrag.location.map { layout.lensCenter(at: $0.x) } ?? layout.center(for: selection.wrappedValue)
            ZStack(alignment: .leading) {
                selectionLens
                    .frame(width: layout.itemWidth, height: 44)
                    .offset(x: lensCenter - layout.itemWidth / 2)
                    .animation(tabDrag.isHorizontal || reduceMotion ? nil : FridayTheme.motion, value: lensCenter)
                    .allowsHitTesting(false)
                HStack(spacing: 6) {
                    ForEach(sections.indices, id: \.self) { index in
                        let section = sections[index]
                        Button {
                            guard !tabDrag.isHorizontal else { return }
                            withAnimation(reduceMotion ? nil : FridayTheme.motion) {
                                selection.wrappedValue = index
                            }
                        } label: {
                            FridaySymbolImage(systemName: section.icon, motion: section == .settings ? .rotate : .drawOn)
                                .font(.system(size: 20, weight: .regular))
                                .foregroundStyle(previewIndex == index ? .primary : .secondary)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Capsule())
                        }
                        .buttonStyle(FridaySymbolButtonStyle())
                        .accessibilityLabel(Text(fridayString: section.rawValue))
                        .accessibilityAddTraits(selection.wrappedValue == index ? .isSelected : [])
                        .contextMenu {
                            if section == .chat, let newConversation {
                                Button(friday: "新对话", systemImage: "square.and.pencil", action: newConversation)
                            }
                        }
                    }
                }
            }
            .contentShape(Rectangle())
            .highPriorityGesture(
                DragGesture(minimumDistance: FridayMobileTabDrag.minimumDistance, coordinateSpace: .local)
                    .updating($trackingDrag) { _, active, _ in active = true }
                    .onChanged { value in
                        tabDrag.update(start: value.startLocation, location: value.location)
                    }
                    .onEnded { value in
                        tabDrag.update(start: value.startLocation, location: value.location)
                        guard let destination = tabDrag.finish(in: layout) else { return }
                        // Commit only on release: replacing a page during a drag would
                        // replace its composer/dock and cancel the ongoing gesture.
                        withAnimation(reduceMotion ? nil : FridayTheme.motion) {
                            selection.wrappedValue = destination
                        }
                    }
            )
        }
        .frame(height: 44)
        .onChange(of: trackingDrag) { _, active in
            if !active { tabDrag.cancel() }
        }
        .onChange(of: selection.wrappedValue) { _, _ in tabDrag.cancel() }
        .onDisappear { tabDrag.cancel() }
    }

    @ViewBuilder private var selectionLens: some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *), !reduceTransparency, contrast != .increased {
            Color.clear
                .glassEffect(.regular.tint(.primary.opacity(0.06)).interactive(), in: Capsule())
                .glassEffectID("selected-tab", in: glassNamespace)
                .glassEffectTransition(reduceMotion ? .identity : .matchedGeometry)
        } else {
            Capsule().fill(Color.primary.opacity(0.07))
        }
        #else
        Capsule().fill(Color.primary.opacity(0.07))
        #endif
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
