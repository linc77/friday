import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Paseo's Lucide commit mark, kept as a static template image.
struct TaskGitCommitIcon: View {
    private static let image: Image? = {
        guard let url = Bundle.module.url(forResource: "GitCommitHorizontal", withExtension: "png") else { return nil }
        #if os(macOS)
        guard let image = NSImage(contentsOf: url) else { return nil }
        image.size = NSSize(width: 16, height: 16)
        image.isTemplate = true
        return Image(nsImage: image)
        #else
        guard let image = UIImage(contentsOfFile: url.path) else { return nil }
        return Image(uiImage: image)
        #endif
    }()

    var body: some View {
        Self.image?
            .renderingMode(.template).resizable().scaledToFit()
            .frame(width: 16, height: 16).accessibilityHidden(true)
    }
}
