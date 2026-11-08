#if os(iOS)
import SwiftUI

/// Native TabView owns selection, hit testing and Liquid Glass rendering.
struct FridayNativeTabBarBehavior: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            content
        }
    }
}

/// These metrics apply only to the composer, never to the system tab bar.
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
