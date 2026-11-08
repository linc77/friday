#if os(iOS)
import SwiftUI
import Observation

/// Measured from the user's 1260 × 2736 Safari reference at 3 px/pt.
enum FridayMobileDockMetrics {
    static let horizontalInset: CGFloat = 14
    static let bottomInset: CGFloat = 14
    static let compactHeight: CGFloat = 34
    static let composerCornerRadius: CGFloat = 40
    static let composerInset: CGFloat = 16
    static let composerBottomInset: CGFloat = 12
    static let inputHeight: CGFloat = 48
    static let navigationRowHeight: CGFloat = 52
    // Omit only the input row; keep the same navigation insets and bottom baseline.
    static let singleRowHeight: CGFloat = composerInset + navigationRowHeight + composerBottomInset

    static func compactWidth(availableWidth: CGFloat) -> CGFloat {
        min(availableWidth, (availableWidth + 2 * horizontalInset) * (254.0 / 589.0))
    }
}

struct FridayMobileNavigationBar: View {
    @Binding var collapsed: Bool
    var embedded = false
    @Environment(\.fridayMobileTabSelection) private var selection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    private let sections: [FridaySection] = [.chat, .inbox, .tasks, .settings]
    private var motion: Animation? {
        reduceMotion || scenePhase != .active ? nil : .smooth(duration: collapsed ? 0.24 : 0.42)
    }

    var body: some View {
        if let selection {
            Group {
                if embedded {
                    paddedNavigationRow(selection: selection)
                } else {
                    floatingBar(selection: selection)
                }
            }
            .onChange(of: selection.wrappedValue) { _, _ in collapsed = false }
        }
    }

    private func floatingBar(selection: Binding<Int>) -> some View {
        GeometryReader { geometry in
            let compactWidth = FridayMobileDockMetrics.compactWidth(availableWidth: geometry.size.width)
            let shape = collapsed ? AnyShape(Capsule()) : AnyShape(RoundedRectangle(cornerRadius: FridayMobileDockMetrics.composerCornerRadius, style: .continuous))
            ZStack(alignment: .bottom) {
                paddedNavigationRow(selection: selection)
                    .padding(.horizontal, FridayMobileDockMetrics.composerInset)
                    .padding(.top, FridayMobileDockMetrics.composerInset)
                    .padding(.bottom, FridayMobileDockMetrics.composerBottomInset)
                    .frame(width: geometry.size.width, height: FridayMobileDockMetrics.singleRowHeight)
                    .opacity(collapsed ? 0 : 1)
                    .allowsHitTesting(!collapsed)
                    .accessibilityHidden(collapsed)
                    .frame(width: collapsed ? compactWidth : geometry.size.width,
                           height: collapsed ? FridayMobileDockMetrics.compactHeight : FridayMobileDockMetrics.singleRowHeight)
                    .clipShape(shape)
                    .modifier(FridayMobileDockSurface(cornerRadius: collapsed ? nil : FridayMobileDockMetrics.composerCornerRadius))
                compactButton(selection: selection.wrappedValue, width: compactWidth)
                    .opacity(collapsed ? 1 : 0)
                    .allowsHitTesting(collapsed)
                    .accessibilityHidden(!collapsed)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .animation(motion, value: collapsed)
        }
        // Keep the scroll viewport fixed while only the floating capsule changes size.
        .frame(height: FridayMobileDockMetrics.singleRowHeight)
        .frame(maxWidth: 600)
        .padding(.horizontal, FridayMobileDockMetrics.horizontalInset)
        .padding(.top, 8)
        .padding(.bottom, FridayMobileDockMetrics.bottomInset)
        .frame(maxWidth: .infinity)
        .modifier(FridayMobileDockBackdrop(collapsed: collapsed))
    }

    private func compactButton(selection: Int, width: CGFloat) -> some View {
        let section = sections[min(max(selection, 0), sections.count - 1)]
        return FridayMobileCompactNavigationButton(section: section, width: width, expand: { collapsed = false })
    }

    private func paddedNavigationRow(selection: Binding<Int>) -> some View {
        FridayMobileNavigationRow(selection: selection, collapsed: collapsed)
            .padding(4)
            .frame(height: FridayMobileDockMetrics.navigationRowHeight)
    }

}

/// One presentation state across retained pages: the incoming dock must inherit
/// the outgoing dock's scrub position rather than starting at the destination.
@Observable
private final class FridayMobileTabPresentation {
    var scrub = FridayMobileTabScrub()
}

private struct FridayMobileTabPresentationKey: EnvironmentKey {
    static let defaultValue: FridayMobileTabPresentation? = nil
}

extension View {
    func fridayMobileTabPresentation() -> some View {
        modifier(FridayMobileTabPresentationHost())
    }
}

private struct FridayMobileTabPresentationHost: ViewModifier {
    @State private var presentation = FridayMobileTabPresentation()

    func body(content: Content) -> some View {
        content.environment(\.fridayMobileTabPresentation, presentation)
    }
}

private extension EnvironmentValues {
    var fridayMobileTabPresentation: FridayMobileTabPresentation? {
        get { self[FridayMobileTabPresentationKey.self] }
        set { self[FridayMobileTabPresentationKey.self] = newValue }
    }
}

/// Only this small row observes touch positions, not the glass/composer dock.
private struct FridayMobileNavigationRow: View {
    @Binding var selection: Int
    let collapsed: Bool
    @Environment(\.fridayMobileTabPresentation) private var sharedPresentation
    @Environment(\.fridayMobileNewConversation) private var newConversation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.scenePhase) private var scenePhase
    @State private var fallbackPresentation = FridayMobileTabPresentation()
    @State private var owner = UUID()
    @GestureState private var trackingDrag = false
    private let sections: [FridaySection] = [.chat, .inbox, .tasks, .settings]
    private var presentation: FridayMobileTabPresentation { sharedPresentation ?? fallbackPresentation }

    var body: some View {
        GeometryReader { geometry in
            let layout = FridayMobileTabLayout(width: geometry.size.width, count: sections.count)
            let lensCenter = presentation.scrub.position.map { layout.center(at: $0) } ?? layout.center(for: selection)
            ZStack(alignment: .leading) {
                // A quiet selection tint inside one glass surface, without a second bright rim.
                Capsule().fill(Color.primary.opacity(contrast == .increased ? 0.18 : 0.065))
                    .frame(width: layout.itemWidth, height: 44)
                    .offset(x: lensCenter - layout.itemWidth / 2)
                    .animation(presentation.scrub.isHorizontal || reduceMotion || scenePhase != .active ? nil : .smooth(duration: 0.18), value: lensCenter)
                    .allowsHitTesting(false)
                HStack(spacing: 6) {
                    ForEach(sections.indices, id: \.self) { index in
                        let section = sections[index]
                        Button {
                            guard !presentation.scrub.isHorizontal else { return }
                            selection = index
                        } label: {
                            FridaySymbolImage(systemName: section.icon)
                                .font(.system(size: 20, weight: .regular))
                                .foregroundStyle(.primary)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Capsule())
                        }
                        .buttonStyle(FridaySymbolButtonStyle())
                        .accessibilityLabel(Text(fridayString: section.rawValue))
                        .accessibilityAddTraits(selection == index ? .isSelected : [])
                        .contextMenu { conversationMenu(for: section) }
                    }
                }
            }
            .contentShape(Rectangle())
            .highPriorityGesture(
                DragGesture(minimumDistance: FridayMobileTabDrag.minimumDistance, coordinateSpace: .local)
                    .updating($trackingDrag) { _, active, _ in active = true }
                    .onChanged { value in
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) {
                            presentation.scrub.update(owner: owner, start: value.startLocation,
                                                      location: value.location, layout: layout)
                        }
                    }
                    .onEnded { value in
                        presentation.scrub.update(owner: owner, start: value.startLocation, location: value.location, layout: layout)
                        guard let destination = presentation.scrub.finish(owner: owner, in: layout) else { return }
                        // Commit on release so the current page stays interactive during scrubbing.
                        selection = destination
                    }
            )
        }
        .frame(height: 44)
        .onChange(of: trackingDrag) { _, active in
            if !active { presentation.scrub.cancel(owner: owner) }
        }
        .onChange(of: selection) { _, _ in presentation.scrub.cancel(owner: owner) }
        .onChange(of: collapsed) { _, _ in presentation.scrub.cancel(owner: owner) }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { presentation.scrub.cancel(owner: owner) }
        }
        .onDisappear { presentation.scrub.cancel(owner: owner) }
    }

    @ViewBuilder private func conversationMenu(for section: FridaySection) -> some View {
        if section == .chat, let newConversation {
            Button(friday: "新对话", systemImage: "square.and.pencil", action: newConversation)
        }
    }
}

/// Safari fades the page into a neutral backdrop before it reaches the glass.
/// Keep this separate from the single glass layer so text never stains the controls.
struct FridayMobileDockBackdrop: ViewModifier {
    var collapsed = false
    var enabled = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content.background {
            if enabled {
                GeometryReader { geometry in
                    let fadeHeight: CGFloat = 24
                    let height = (collapsed ? FridayMobileDockMetrics.compactHeight + FridayMobileDockMetrics.bottomInset : geometry.size.height) + fadeHeight
                    LinearGradient(stops: [
                        .init(color: Color(uiColor: .systemBackground).opacity(0), location: 0),
                        .init(color: Color(uiColor: .systemBackground), location: fadeHeight / height),
                        .init(color: Color(uiColor: .systemBackground), location: 1)
                    ], startPoint: .top, endPoint: .bottom)
                    .frame(height: height)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .animation(reduceMotion || scenePhase != .active ? nil : .smooth(duration: collapsed ? 0.24 : 0.42), value: collapsed)
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }
}

/// Shared by standalone navigation and the unified chat dock; expanding never focuses the editor.
struct FridayMobileCompactNavigationButton: View {
    let section: FridaySection
    let width: CGFloat
    let expand: () -> Void
    @Environment(\.fridayMobileNewConversation) private var newConversation

    var body: some View {
        Button(action: expand) {
            FridaySymbolImage(systemName: section.icon)
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(.primary)
                .frame(width: width, height: FridayMobileDockMetrics.compactHeight)
                // Extend the tap target upward without moving the visible capsule off its baseline.
                .frame(height: 44, alignment: .bottom)
                .contentShape(Rectangle())
        }
        .buttonStyle(FridaySymbolButtonStyle())
        .accessibilityLabel(Text(fridayString: section.rawValue))
        .accessibilityHint(Text(friday: "展开底部导航"))
        .contextMenu {
            if section == .chat, let newConversation {
                Button(friday: "新对话", systemImage: "square.and.pencil", action: newConversation)
            }
        }
    }
}

/// One native material layer; no decorative outline or interactive outer lens.
struct FridayMobileDockSurface: ViewModifier {
    var cornerRadius: CGFloat? = nil
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    @ViewBuilder func body(content: Content) -> some View {
        let shape = cornerRadius.map { AnyShape(RoundedRectangle(cornerRadius: $0, style: .continuous)) }
            ?? AnyShape(Capsule())
        if reduceTransparency || contrast == .increased {
            content
                .background(Color(uiColor: .secondarySystemBackground), in: shape)
                .overlay {
                    if contrast == .increased {
                        shape.stroke(.primary.opacity(0.35), lineWidth: 1).allowsHitTesting(false)
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
