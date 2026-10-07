import AppKit
import SwiftUI
@testable import FridayKit

@main
struct NoteComposerWindowTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let store = FridayStore()
        store.outbox = []
        let composer = NoteComposerWindow()
        let window = composer.prepare(store: store, parent: nil, delegate: { _ in })
        let editor = window.contentView
        precondition(window.identifier?.rawValue == "friday.note-composer")
        precondition(window.styleMask.contains(.resizable) && window.collectionBehavior.contains(.fullScreenPrimary), "The popup supports native full-screen editing")
        precondition(composer.prepare(store: store, parent: nil, delegate: { _ in }) === window,
                     "Repeated create requests reuse the open draft instead of spawning competing editors")
        precondition(window.contentView === editor)

        let notification = Notification(name: NSWindow.willEnterFullScreenNotification, object: window)
        composer.windowWillEnterFullScreen(notification)
        precondition(composer.transitioning, "Disable repeated full-screen requests during a transition")
        composer.windowDidFailToEnterFullScreen(window)
        precondition(!composer.transitioning && !composer.isFullScreen, "A failed transition must re-enable the expand control")
        composer.windowWillExitFullScreen(notification)
        composer.windowDidFailToExitFullScreen(window)
        precondition(!composer.transitioning)
        precondition(window.contentView === editor, "Full-screen state changes retain the same editor and undo history")

        composer.close()
        precondition(composer.window == nil && window.contentView == nil, "Closing releases the editor and allows a fresh note")
        precondition(store.outbox.isEmpty, "Opening and closing an empty composer must not create blank notes")
        let next = composer.prepare(store: store, parent: nil, delegate: { _ in })
        precondition(next !== window, "New opens after closing start a fresh editor")
        composer.close()
        print("Note composer window reuse, native full-screen capability, transition recovery, editor identity and close lifecycle passed")
    }
}
