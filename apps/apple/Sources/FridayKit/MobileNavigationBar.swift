#if os(iOS)
import SwiftUI

/// One moving capsule shared across pages, above a static single glass surface.
struct FridayMobileNavigationRow: View {
    @Environment(\.fridayMobileTabSelection) private var selection
    @Environment(\.fridayNavigationMotion) private var motion
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag = FridayNavigationDrag()
    @State private var owner = UUID()
    @GestureState private var tracking = false
    private let sections: [FridaySection] = [.chat, .inbox, .tasks, .settings]

    var body: some View {
        if let selection, let motion {
            GeometryReader { geometry in
                let layout = FridayNavigationGeometry(width: geometry.size.width, count: sections.count)
                ZStack(alignment: .leading) {
                    Capsule().fill(.primary.opacity(0.08))
                        .frame(width: layout.itemWidth, height: 52)
                        .offset(x: motion.position * (layout.itemWidth + layout.spacing))
                        .allowsHitTesting(false)
                    HStack(spacing: layout.spacing) {
                        ForEach(sections.indices, id: \.self) { index in
                            let section = sections[index]
                            Button {
                                guard !drag.isHorizontal else { return }
                                motion.move(to: index, animated: !reduceMotion)
                                selection.wrappedValue = index
                            } label: {
                                VStack(spacing: 3) {
                                    FridaySymbolImage(systemName: section.icon)
                                        .font(.system(size: 22, weight: .regular))
                                    Text(fridayString: section.rawValue).font(.caption2).lineLimit(1)
                                }
                                .foregroundStyle(.primary)
                                .frame(maxWidth: .infinity, minHeight: 52)
                                .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(selection.wrappedValue == index ? .isSelected : [])
                        }
                    }
                }
                // Frames come from the shared display-linked position; don't
                // interpolate them again or animate the surrounding page layout.
                .transaction { $0.animation = nil }
                .contentShape(Rectangle())
                .highPriorityGesture(
                    DragGesture(minimumDistance: FridayNavigationDrag.minimumDistance)
                        .updating($tracking) { _, active, _ in active = true }
                        .onChanged { value in
                            drag.update(start: value.startLocation, location: value.location)
                            if drag.isHorizontal {
                                motion.drag(to: layout.position(at: value.location.x), owner: owner)
                            }
                        }
                        .onEnded { value in
                            drag.update(start: value.startLocation, location: value.location)
                            if drag.isHorizontal {
                                motion.drag(to: layout.position(at: value.location.x), owner: owner)
                                let destination = layout.index(at: value.location.x)
                                motion.move(to: destination, animated: !reduceMotion)
                                selection.wrappedValue = destination
                            }
                            drag = FridayNavigationDrag()
                        }
                )
            }
            .frame(height: 52)
            .onChange(of: tracking) { _, active in
                if !active {
                    motion.cancelDrag(owner: owner, selection: selection.wrappedValue, animated: !reduceMotion)
                    drag = FridayNavigationDrag()
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
