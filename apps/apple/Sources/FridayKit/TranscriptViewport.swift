import SwiftUI

struct TranscriptViewportMetrics: Equatable, Sendable {
    var topInset: CGFloat = 0
    var height: CGFloat = 0
}

/// Width belongs to layout, not transcript content. A GeometryReader around the
/// whole ScrollView reevaluates its content closure for every divider sample.
/// Observe only the geometry that the transcript actually needs as data.
struct TranscriptViewport<Content: View>: View {
    @State private var metrics = TranscriptViewportMetrics()
    @ViewBuilder let content: (TranscriptViewportMetrics) -> Content

    var body: some View {
        content(metrics)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onGeometryChange(for: TranscriptViewportMetrics.self) { geometry in
                TranscriptViewportMetrics(topInset: geometry.safeAreaInsets.top, height: geometry.size.height)
            } action: { metrics = $0 }
    }
}
