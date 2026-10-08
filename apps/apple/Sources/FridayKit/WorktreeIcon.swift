import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The shared Codicons worktree mark stays static and inherits its foreground color.
struct WorktreeIcon: View {
    var size: CGFloat = 14

    private static let image: Image? = {
        guard let url = Bundle.module.url(forResource: "Worktree", withExtension: "png") else { return nil }
        #if os(macOS)
        guard let image = NSImage(contentsOf: url) else { return nil }
        return Image(nsImage: image)
        #else
        guard let image = UIImage(contentsOfFile: url.path) else { return nil }
        return Image(uiImage: image)
        #endif
    }()

    var body: some View {
        Self.image?
            .renderingMode(.template)
            .resizable().scaledToFit()
            .frame(width: size, height: size)
    }
}
