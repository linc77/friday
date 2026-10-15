#if os(macOS)
import SwiftUI

/// Measures the mounted content directly, including attachments and errors.
/// Only collapse changes the available height; expanded content is never clipped
/// by a stale geometry preference from the surrounding glass surface.
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
