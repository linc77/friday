#if os(macOS)
import AppKit
import SwiftUI

/// A single native composer above the gallery. Full screen resizes this same
/// hosting view, preserving the draft, insertion point, and native undo history.
@MainActor
final class NoteComposerWindow: NSObject, ObservableObject, NSWindowDelegate {
    @Published private(set) var isFullScreen = false
    @Published private(set) var transitioning = false
    @Published private(set) var scenePhase: ScenePhase = .inactive
    private(set) var window: NSWindow?
    private weak var parentWindow: NSWindow?
    private weak var store: FridayStore?

    override init() {
        super.init()
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(updateActivity), name: name, object: nil)
        }
    }

    func show(store: FridayStore, delegate: @escaping (Idea) -> Void) {
        let parent = NSApp.keyWindow
        let composer = prepare(store: store, parent: parent, delegate: delegate)
        composer.makeKeyAndOrderFront(nil)
        updateActivity()
    }

    /// Construction is separate from presentation so the window contract can
    /// be checked without launching a second app or connecting another store.
    @discardableResult
    func prepare(store: FridayStore, parent: NSWindow?, delegate: @escaping (Idea) -> Void) -> NSWindow {
        if let window { return window }
        self.store = store; parentWindow = parent
        let available = parent?.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1180, height: 780)
        let size = NSSize(width: min(840, available.width - 80), height: min(660, available.height - 80))
        let composer = NoteComposerNativeWindow(contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        composer.identifier = NSUserInterfaceItemIdentifier("friday.note-composer")
        composer.title = "\(FridayAppName.displayName) · Note"
        composer.titleVisibility = .hidden
        composer.titlebarAppearsTransparent = true
        composer.isReleasedWhenClosed = false
        composer.minSize = NSSize(width: 620, height: 480)
        composer.collectionBehavior = [.fullScreenPrimary]
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            composer.standardWindowButton(button)?.isHidden = true
        }
        composer.delegate = self
        window = composer
        composer.contentView = NSHostingView(rootView: NoteComposerContent(store: store, composer: self) { [weak self] idea in
            self?.close()
            delegate(idea)
        })
        let center = parent?.frame ?? available
        let origin = NSPoint(
            x: min(max(center.midX - composer.frame.width / 2, available.minX), available.maxX - composer.frame.width),
            y: min(max(center.midY - composer.frame.height / 2, available.minY), available.maxY - composer.frame.height))
        composer.setFrameOrigin(origin)
        return composer
    }

    func close() { window?.performClose(nil) }

    func toggleFullScreen() {
        guard let window, !transitioning else { return }
        transitioning = true
        window.toggleFullScreen(nil)
    }

    @objc private func updateActivity() {
        scenePhase = !NSApp.isActive ? .background : window?.isKeyWindow == true ? .active : .inactive
    }
    func windowDidBecomeKey(_ notification: Notification) { updateActivity() }
    func windowDidResignKey(_ notification: Notification) { updateActivity() }
    func windowWillEnterFullScreen(_ notification: Notification) { transitioning = true }
    func windowWillExitFullScreen(_ notification: Notification) { transitioning = true }
    func windowDidEnterFullScreen(_ notification: Notification) { updateFullScreen() }
    func windowDidExitFullScreen(_ notification: Notification) { updateFullScreen() }
    func windowDidFailToEnterFullScreen(_ window: NSWindow) { updateFullScreen() }
    func windowDidFailToExitFullScreen(_ window: NSWindow) { updateFullScreen() }
    private func updateFullScreen() {
        isFullScreen = window?.styleMask.contains(.fullScreen) == true
        transitioning = false
    }

    func windowWillClose(_ notification: Notification) {
        store?.scheduleNoteSync(immediately: true)
        window?.contentView = nil
        window?.delegate = nil
        window = nil; store = nil
        isFullScreen = false; transitioning = false; scenePhase = .inactive
        parentWindow?.makeKeyAndOrderFront(nil)
        parentWindow = nil
    }
}

private final class NoteComposerNativeWindow: NSWindow {
    override func cancelOperation(_ sender: Any?) {
        if styleMask.contains(.fullScreen) { toggleFullScreen(sender) }
        else { performClose(sender) }
    }
}

private struct NoteComposerContent: View {
    @ObservedObject var store: FridayStore
    @ObservedObject var composer: NoteComposerWindow
    let delegate: (Idea) -> Void
    @AppStorage(FridayPreferenceKeys.language) private var language: FridayLanguage = .chinese
    @AppStorage(FridayPreferenceKeys.appearance) private var appearance: FridayAppearance = .system

    var body: some View {
        IdeaDetailView(store: store, initial: nil, isFullScreen: composer.isFullScreen,
                       fullScreenTransitioning: composer.transitioning,
                       toggleFullScreen: { composer.toggleFullScreen() }, delegate: delegate,
                       close: { composer.close() })
            .frame(minWidth: 620, minHeight: 480)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(FridayTheme.canvas)
            .tint(FridayTheme.accent)
            .buttonStyle(FridayDefaultButtonStyle())
            .environment(\.locale, language.locale)
            .environment(\.scenePhase, composer.scenePhase)
            .preferredColorScheme(appearance.colorScheme)
            .ignoresSafeArea(.container, edges: .top)
    }
}
#endif
