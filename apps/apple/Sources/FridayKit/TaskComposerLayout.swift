#if os(macOS)
import SwiftUI

/// Animation geometry is local to the floating composer. The transcript reserves
/// its expanded size, so folding cannot resize the document under a scroll gesture.
final class TaskComposerGeometry {
    var reservedHeight: CGFloat = 136
    var naturalHeight: CGFloat = 0
    var surfaceHeight: CGFloat = 0
    var expanded = true

    func requestCollapse() -> Bool {
        guard expanded else { return false }
        expanded = false
        return true
    }

    var occlusionHeight: CGFloat {
        guard naturalHeight > 0, surfaceHeight > 0 else { return reservedHeight }
        return max(0, reservedHeight - naturalHeight + surfaceHeight)
    }
}

private struct TaskComposerGeometryKey: EnvironmentKey {
    static let defaultValue: TaskComposerGeometry? = nil
}

extension EnvironmentValues {
    var taskComposerGeometry: TaskComposerGeometry? {
        get { self[TaskComposerGeometryKey.self] }
        set { self[TaskComposerGeometryKey.self] = newValue }
    }
}

private struct TaskComposerNaturalHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Measure the always-mounted editor before the animated clipping layout.
struct TaskComposerMeasurement: ViewModifier {
    func body(content: Content) -> some View {
        content.background(GeometryReader { geometry in
            Color.clear.preference(key: TaskComposerNaturalHeightKey.self, value: geometry.size.height)
        })
    }
}

struct TaskComposerReservation: ViewModifier {
    let expanded: Bool
    @Environment(\.taskComposerGeometry) private var geometry
    @State private var naturalHeight: CGFloat?

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { height in
                // Hit testing needs the live surface, not the reserved space.
                // This reference is deliberately not observable SwiftUI state.
                geometry?.surfaceHeight = height
            }
            .frame(height: naturalHeight, alignment: .bottom)
            .onChange(of: expanded, initial: true) { _, value in geometry?.expanded = value }
            .onPreferenceChange(TaskComposerNaturalHeightKey.self) { height in
                guard height > 0, naturalHeight != height else { return }
                geometry?.naturalHeight = height
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { naturalHeight = height }
            }
    }
}

/// Measures the mounted content directly, including attachments and errors.
/// Only collapse changes the available height; expanded content is never clipped
/// by a stale geometry preference from the surrounding surface.
struct TaskComposerLayout: Layout {
    var expansion: CGFloat
    var animatableData: CGFloat {
        get { expansion }
        set { expansion = newValue }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let content = subviews.first else { return .zero }
        let natural = content.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
        let progress = min(1, max(0, expansion))
        return CGSize(width: natural.width, height: 44 + (max(44, natural.height) - 44) * progress)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let content = subviews.first else { return }
        let natural = content.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
        content.place(at: CGPoint(x: bounds.minX, y: bounds.maxY), anchor: .bottomLeading,
                      proposal: ProposedViewSize(width: bounds.width, height: natural.height))
    }
}
#endif
