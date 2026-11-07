#if os(iOS)
import SwiftUI

struct FridayMobileNavigationBar: View {
    @Binding var collapsed: Bool
    @Environment(\.fridayMobileTabSelection) private var selection
    @Environment(\.fridayMobileNewConversation) private var newConversation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.scenePhase) private var scenePhase
    @GestureState private var trackingDrag = false
    @State private var tabDrag = FridayMobileTabDrag()
    private let sections: [FridaySection] = [.chat, .inbox, .tasks, .settings]
    private var motion: Animation? {
        reduceMotion || scenePhase != .active ? nil : .smooth(duration: collapsed ? 0.24 : 0.42)
    }

    var body: some View {
        if let selection {
            GeometryReader { geometry in
                ZStack {
                    navigationRow(selection: selection)
                        .padding(4)
                        .frame(width: geometry.size.width, height: 52)
                        .opacity(collapsed ? 0 : 1)
                        .allowsHitTesting(!collapsed)
                        .accessibilityHidden(collapsed)
                    compactButton(selection: selection.wrappedValue)
                        .opacity(collapsed ? 1 : 0)
                        .allowsHitTesting(collapsed)
                        .accessibilityHidden(!collapsed)
                }
                .frame(width: collapsed ? 76 : geometry.size.width, height: collapsed ? 44 : 52)
                .clipShape(Capsule())
                .modifier(FridayMobileDockSurface(cornerRadius: 26))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .animation(motion, value: collapsed)
            }
            // Keep the scroll viewport fixed while only the floating capsule changes size.
            .frame(height: 52)
            .frame(maxWidth: 600)
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 10)
            .frame(maxWidth: .infinity)
            .onChange(of: trackingDrag) { _, active in
                if !active { tabDrag.cancel() }
            }
            .onChange(of: selection.wrappedValue) { _, _ in tabDrag.cancel(); collapsed = false }
            .onChange(of: collapsed) { _, _ in tabDrag.cancel() }
            .onDisappear { tabDrag.cancel() }
        }
    }

    private func compactButton(selection: Int) -> some View {
        let section = sections[min(max(selection, 0), sections.count - 1)]
        return Button { collapsed = false } label: {
            FridaySymbolImage(systemName: section.icon, motion: section == .settings ? .rotate : .drawOn)
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(.primary)
                .frame(width: 76, height: 44)
                .contentShape(Capsule())
        }
        .buttonStyle(FridaySymbolButtonStyle())
        .accessibilityLabel(Text(fridayString: section.rawValue))
        .accessibilityHint(Text(friday: "展开底部导航"))
        .contextMenu { conversationMenu(for: section) }
    }

    private func navigationRow(selection: Binding<Int>) -> some View {
        GeometryReader { geometry in
            let layout = FridayMobileTabLayout(width: geometry.size.width, count: sections.count)
            let previewIndex = tabDrag.location.map { layout.index(at: $0.x) } ?? selection.wrappedValue
            let lensCenter = tabDrag.location.map { layout.lensCenter(at: $0.x) } ?? layout.center(for: selection.wrappedValue)
            ZStack(alignment: .leading) {
                // A quiet selection tint inside one glass surface, without a second bright rim.
                Capsule().fill(Color.primary.opacity(contrast == .increased ? 0.18 : 0.065))
                    .frame(width: layout.itemWidth, height: 44)
                    .offset(x: lensCenter - layout.itemWidth / 2)
                    .animation(tabDrag.isHorizontal || reduceMotion || scenePhase != .active ? nil : FridayTheme.motion, value: lensCenter)
                    .allowsHitTesting(false)
                HStack(spacing: 6) {
                    ForEach(sections.indices, id: \.self) { index in
                        let section = sections[index]
                        Button {
                            guard !tabDrag.isHorizontal else { return }
                            selection.wrappedValue = index
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
                        .contextMenu { conversationMenu(for: section) }
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
                        // Changing pages during a drag would remove its navigation bar.
                        selection.wrappedValue = destination
                    }
            )
        }
        .frame(height: 44)
    }

    @ViewBuilder private func conversationMenu(for section: FridaySection) -> some View {
        if section == .chat, let newConversation {
            Button(friday: "新对话", systemImage: "square.and.pencil", action: newConversation)
        }
    }
}

/// One native material layer; no decorative outline or interactive outer lens.
struct FridayMobileDockSurface: ViewModifier {
    let cornerRadius: CGFloat
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    @ViewBuilder func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius)
        if reduceTransparency || contrast == .increased {
            content
                .background(Color(uiColor: .secondarySystemBackground), in: shape)
                .overlay {
                    if contrast == .increased {
                        shape.strokeBorder(.primary.opacity(0.35), lineWidth: 1).allowsHitTesting(false)
                    }
                }
        } else {
            #if compiler(>=6.2)
            if #available(iOS 26.0, *) {
                content.glassEffect(.regular, in: shape)
            } else {
                content.background(.regularMaterial, in: shape)
            }
            #else
            content.background(.regularMaterial, in: shape)
            #endif
        }
    }
}
#endif
