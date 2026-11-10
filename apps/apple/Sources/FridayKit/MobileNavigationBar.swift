#if os(iOS)
import SwiftUI
import UIKit

/// One moving capsule shared across pages, above a static single glass surface.
struct FridayMobileNavigationRow: View {
    @Environment(\.fridayMobileTabSelection) private var selection
    @Environment(\.fridayNavigationMotion) private var motion
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag = FridayNavigationDrag()
    @State private var owner = UUID()
    @State private var pressed = false
    @GestureState private var tracking = false
    private let sections: [FridaySection] = [.chat, .inbox, .tasks, .settings]
    private static let height: CGFloat = 44

    /// Switch pages immediately; the capsule slide already runs in Core Animation.
    private func commit(_ destination: Int, motion: FridayNavigationMotion, selection: Binding<Int>) {
        selection.wrappedValue = destination
    }

    var body: some View {
        if let selection, let motion {
            GeometryReader { geometry in
                let layout = FridayNavigationGeometry(width: geometry.size.width, count: sections.count)
                ZStack(alignment: .leading) {
                    FridayNavigationCapsule(
                        motion: motion,
                        transition: motion.transition,
                        step: layout.itemWidth + layout.spacing,
                        size: CGSize(width: layout.itemWidth, height: Self.height)
                    )
                    .allowsHitTesting(false)
                    HStack(spacing: layout.spacing) {
                        ForEach(sections.indices, id: \.self) { index in
                            let section = sections[index]
                            Button {
                                guard !drag.isHorizontal else { return }
                                motion.move(to: index, animated: !reduceMotion)
                                commit(index, motion: motion, selection: selection)
                            } label: {
                                FridaySymbolImage(systemName: section.icon)
                                    .font(.system(size: 22, weight: .regular))
                                    .foregroundStyle(.primary)
                                    .frame(maxWidth: .infinity, minHeight: Self.height)
                                    .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(fridayString: section.rawValue))
                            .accessibilityAddTraits(selection.wrappedValue == index ? .isSelected : [])
                        }
                    }
                }
                // The capsule animates in Core Animation; never animate the row layout.
                .transaction { $0.animation = nil }
                .contentShape(Rectangle())
                .highPriorityGesture(
                    // Zero distance: the capsule answers touch-down; the page switches on lift.
                    DragGesture(minimumDistance: 0)
                        .updating($tracking) { _, active, _ in active = true }
                        .onChanged { value in
                            if !pressed {
                                pressed = true
                                motion.move(to: layout.index(at: value.startLocation.x), animated: !reduceMotion)
                            }
                            drag.update(start: value.startLocation, location: value.location)
                            if drag.isHorizontal {
                                motion.drag(to: layout.position(at: value.location.x), owner: owner)
                            }
                        }
                        .onEnded { value in
                            drag.update(start: value.startLocation, location: value.location)
                            if drag.isHorizontal {
                                motion.drag(to: layout.position(at: value.location.x), owner: owner)
                            }
                            let destination = layout.index(at: value.location.x)
                            motion.move(to: destination, animated: !reduceMotion)
                            commit(destination, motion: motion, selection: selection)
                            drag = FridayNavigationDrag()
                            pressed = false
                        }
                )
            }
            .frame(height: Self.height)
            .onChange(of: tracking) { _, active in
                if !active {
                    motion.move(to: selection.wrappedValue, animated: !reduceMotion)
                    drag = FridayNavigationDrag()
                    pressed = false
                }
            }
            .onDisappear {
                motion.cancelDrag(owner: owner, selection: selection.wrappedValue, animated: !reduceMotion)
                drag = FridayNavigationDrag()
            }
        }
    }
}

/// Shared insets for the unified home dock and standalone detail composers.
enum FridayMobileDockMetrics {
    static let horizontalInset: CGFloat = 14
    static let inputHeight: CGFloat = 48
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
