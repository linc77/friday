#if os(macOS)
import AppKit
import SwiftUI

extension View {
    /// A trailing-aligned list below its trigger, without native popover chrome.
    func fridayDropdown<Content: View>(isPresented: Binding<Bool>, width: CGFloat, height: CGFloat,
                                      @ViewBuilder content: () -> Content) -> some View {
        modifier(FridayDropdownModifier(isPresented: isPresented, width: width, height: height, menu: content()))
    }
}

private struct FridayDropdownModifier<Menu: View>: ViewModifier {
    @Binding var isPresented: Bool
    let width: CGFloat
    let height: CGFloat
    let menu: Menu
    @Environment(\.locale) private var locale
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isEnabled) private var isEnabled

    func body(content: Content) -> some View {
        content.background {
            FridayDropdownAnchor(isPresented: $isPresented, enabled: isEnabled,
                size: CGSize(width: width, height: height),
                menu: AnyView(menu
                    .environment(\.locale, locale)
                    .environment(\.colorScheme, colorScheme)
                    .font(FridayTheme.interfaceFont)
                    .foregroundStyle(FridayTheme.settingsSelectionForeground)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .modifier(SettingsMenuSurface())))
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .onChange(of: isEnabled) { _, enabled in if !enabled { isPresented = false } }
        .onDisappear { isPresented = false }
    }
}

private struct FridayDropdownAnchor: NSViewRepresentable {
    @Binding var isPresented: Bool
    let enabled: Bool
    let size: CGSize
    let menu: AnyView

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSView { NSView() }
    func updateNSView(_ view: NSView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onDismiss = { isPresented = false }
        if isPresented && enabled {
            coordinator.show(anchor: view, size: size, menu: menu)
        } else {
            coordinator.close(notify: false)
        }
    }
    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) {
        coordinator.close(notify: false)
    }

    @MainActor final class Coordinator: NSObject, NSWindowDelegate {
        var onDismiss: (() -> Void)?
        private var panel: FridayDropdownPanel?
        private var host: NSHostingView<AnyView>?
        private weak var anchor: NSView?
        private var localMonitor: Any?
        private var globalMonitor: Any?
        private var observers: [NSObjectProtocol] = []

        func show(anchor: NSView, size: CGSize, menu: AnyView) {
            guard let window = anchor.window else { return }
            self.anchor = anchor
            let rect = window.convertToScreen(anchor.convert(anchor.bounds, to: nil))
            let visible = window.screen?.visibleFrame ?? window.frame
            let gap: CGFloat = 6
            let width = min(size.width, visible.width - 16)
            // AppKit screen coordinates grow upward. Keep the top edge BELOW
            // the trigger, shortening the scrollable list when space is limited.
            let height = min(size.height, max(1, rect.minY - visible.minY - gap - 8))
            let frame = NSRect(x: min(max(visible.minX + 8, rect.maxX - width), visible.maxX - width - 8),
                               y: rect.minY - gap - height, width: width, height: height)
            if let panel, let host {
                host.rootView = menu
                panel.setFrame(frame, display: true)
                return
            }
            let panel = FridayDropdownPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = true
            panel.hidesOnDeactivate = true
            panel.isReleasedWhenClosed = false
            panel.collectionBehavior = [.transient, .ignoresCycle]
            panel.appearance = window.effectiveAppearance
            panel.delegate = self
            let host = NSHostingView(rootView: menu)
            panel.contentView = host
            self.panel = panel
            self.host = host
            window.addChildWindow(panel, ordered: .above)
            panel.makeKeyAndOrderFront(nil)
            installDismissalObservers(parent: window)
        }

        private func installDismissalObservers(parent: NSWindow) {
            localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel]) { [weak self] event in
                guard let self, let panel = self.panel else { return event }
                if event.type == .keyDown {
                    if event.keyCode == 53 { self.close(); return nil }
                } else if event.window !== panel {
                    let clickedTrigger = event.type != .scrollWheel && self.anchor.map { anchor in
                        event.window === anchor.window && anchor.bounds.contains(anchor.convert(event.locationInWindow, from: nil))
                    } == true
                    self.close()
                    if clickedTrigger { return nil }
                }
                return event
            }
            globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
                self?.close()
            }
            let center = NotificationCenter.default
            for name in [NSWindow.willCloseNotification, NSWindow.willMoveNotification, NSWindow.willStartLiveResizeNotification] {
                observers.append(center.addObserver(forName: name, object: parent, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.close() }
                })
            }
            observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close() }
            })
        }

        func windowDidResignKey(_ notification: Notification) { close() }

        func close(notify: Bool = true) {
            guard let panel else { return }
            self.panel = nil
            panel.delegate = nil
            let parent = panel.parent
            let restoreFocus = panel.isKeyWindow && NSApp.isActive
            parent?.removeChildWindow(panel)
            panel.orderOut(nil)
            panel.contentView = nil
            panel.close()
            host = nil
            if let localMonitor { NSEvent.removeMonitor(localMonitor) }
            if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
            localMonitor = nil
            globalMonitor = nil
            observers.forEach { NotificationCenter.default.removeObserver($0) }
            observers.removeAll()
            if restoreFocus { parent?.makeKey() }
            if notify { onDismiss?() }
        }
    }
}

private final class FridayDropdownPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
#endif
