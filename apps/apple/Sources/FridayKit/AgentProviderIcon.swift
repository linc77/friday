import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Brand marks stay static; functional controls retain SF Symbols feedback.
struct AgentProviderIcon: View {
    let provider: String
    var size: CGFloat = 16

    private static let codex = bundledImage("AgentCodex")
    private static let claude = bundledImage("AgentClaude")
    private var logo: Image? { provider == "codex" ? Self.codex : provider == "claude" ? Self.claude : nil }

    var body: some View {
        Group {
            if let logo {
                logo.renderingMode(provider == "claude" ? .original : .template)
                    .resizable().scaledToFit()
            } else {
                FridaySymbolImage(systemName: "terminal").font(.system(size: size))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    // SwiftPM packages these as loose PNGs, not asset-catalog entries.
    private static func bundledImage(_ name: String) -> Image? {
        guard let url = Bundle.module.url(forResource: name, withExtension: "png") else { return nil }
        #if os(macOS)
        guard let image = NSImage(contentsOf: url) else { return nil }
        return Image(nsImage: image)
        #else
        guard let image = UIImage(contentsOfFile: url.path) else { return nil }
        return Image(uiImage: image)
        #endif
    }
}
