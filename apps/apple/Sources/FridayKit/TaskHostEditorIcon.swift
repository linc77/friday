#if os(macOS)
import AppKit
import SwiftUI

/// Use the installed app's own artwork, like Paseo's editor target icons.
/// The icon is decorative; opening files still goes through the host transport.
struct TaskHostEditorIcon: View {
    let editor: TaskHostEditor?
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFit()
            } else {
                FridaySymbolImage(systemName: editor?.symbol ?? "arrow.up.forward.app")
                    .font(.system(size: 16))
            }
        }
        .frame(width: 16, height: 16).accessibilityHidden(true)
        .task(id: editor?.id) {
            let icon = applicationIcon()?.copy() as? NSImage
            icon?.size = NSSize(width: 16, height: 16)
            image = icon
        }
    }

    private func applicationIcon() -> NSImage? {
        guard let editor else { return nil }
        if editor.id == "file-manager" {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.finder") else { return nil }
            return NSWorkspace.shared.icon(forFile: url.path)
        }
        let names: [String]
        switch editor.id {
        case "vscode": names = ["Visual Studio Code"]
        case "vscode-insiders": names = ["Visual Studio Code - Insiders"]
        case "antigravity": names = ["Antigravity IDE"]
        case "idea": names = ["IntelliJ IDEA", "IntelliJ IDEA CE", "IntelliJ IDEA Ultimate"]
        case "pycharm": names = ["PyCharm", "PyCharm CE"]
        case "rider": names = ["Rider", "JetBrains Rider"]
        default: names = [editor.label]
        }
        let roots = [URL(fileURLWithPath: "/Applications"), FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")]
        for root in roots {
            for name in names {
                let url = root.appendingPathComponent(name + ".app")
                if FileManager.default.fileExists(atPath: url.path) {
                    return NSWorkspace.shared.icon(forFile: url.path)
                }
            }
        }
        return nil
    }
}
#endif
