import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum FridayTheme {
    static var accent: Color {
        #if os(macOS)
        Color(nsColor: .labelColor)
        #else
        Color(uiColor: .label)
        #endif
    }

    static var onAccent: Color {
        #if os(macOS)
        Color(nsColor: .textBackgroundColor)
        #else
        Color(uiColor: .systemBackground)
        #endif
    }
    static let contentWidth: CGFloat = 780
    static let cornerRadius: CGFloat = 20
    static let motion = Animation.spring(response: 0.28, dampingFraction: 0.86)
    #if os(macOS)
    static let sidebarWidth: CGFloat = 60
    static let trafficLightSize: CGFloat = 13.2
    static let trafficLightSpacing: CGFloat = 4
    static let sidebarTopInset: CGFloat = 40
    static let windowEdgeInset: CGFloat = 5
    static let sidebarButtonSize: CGFloat = 32
    static let sidebarIconSize: CGFloat = 17
    static let sidebarCornerRadius: CGFloat = 8
    #endif

    static var canvas: Color {
        #if os(macOS)
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? NSColor(white: 0.11, alpha: 1)
                : NSColor(white: 0.965, alpha: 1)
        })
        #else
        Color(uiColor: .systemGroupedBackground)
        #endif
    }

    static var surface: Color {
        #if os(macOS)
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? NSColor(white: 0.15, alpha: 1)
                : NSColor.white
        })
        #else
        Color(uiColor: .secondarySystemGroupedBackground)
        #endif
    }
}

struct FridayMark: View {
    var size: CGFloat = 40
    var body: some View {
        FridaySymbolImage(systemName: "sparkle")
            .font(.system(size: size * 0.52, weight: .medium))
            .foregroundStyle(FridayTheme.accent)
            .frame(width: size, height: size)
            .background(FridayTheme.accent.opacity(0.09), in: RoundedRectangle(cornerRadius: size * 0.32))
            .fridaySymbolFeedback()
            .accessibilityHidden(true)
    }
}

struct PageHeading: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(fridayString: title).font(.largeTitle.weight(.semibold)).tracking(-0.6)
            Text(fridayString: subtitle).font(.callout).foregroundStyle(.secondary).lineSpacing(4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct FridayCard: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    var radius: CGFloat
    var highlighted: Bool

    func body(content: Content) -> some View {
        content
            .background(FridayTheme.surface, in: RoundedRectangle(cornerRadius: radius))
            .overlay {
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(highlighted ? FridayTheme.accent.opacity(0.5) : Color.primary.opacity(contrast == .increased ? 0.3 : 0.07), lineWidth: 1)
            }
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.1 : 0.035), radius: 12, x: 0, y: 4)
    }
}

/// Glass belongs to the floating controls; reading surfaces stay opaque.
private struct FridayFloatingSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    @ViewBuilder func body(content: Content) -> some View {
        if reduceTransparency || contrast == .increased {
            content.fridayCard()
        } else {
            #if compiler(>=6.2)
            if #available(macOS 26.0, iOS 26.0, *) {
                content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: FridayTheme.cornerRadius))
            } else {
                materialSurface(content)
            }
            #else
            materialSurface(content)
            #endif
        }
    }

    private func materialSurface(_ content: Content) -> some View {
        content
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: FridayTheme.cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: FridayTheme.cornerRadius).strokeBorder(.primary.opacity(0.08)))
            .shadow(color: .black.opacity(0.06), radius: 14, x: 0, y: 5)
    }
}

extension View {
    func fridayCard(radius: CGFloat = FridayTheme.cornerRadius, highlighted: Bool = false) -> some View {
        modifier(FridayCard(radius: radius, highlighted: highlighted))
    }

    func fridayFloatingSurface() -> some View {
        modifier(FridayFloatingSurface())
    }
}

#if os(macOS)
/// One continuous native material behind the rail, title bar, and content edges.
struct FridayWindowBackground: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        FridayWindowVisualEffect()
            .overlay {
                if reduceTransparency || contrast == .increased {
                    Color(nsColor: .windowBackgroundColor)
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

private struct FridayWindowVisualEffect: NSViewRepresentable {
    func makeNSView(context: Context) -> FridayWindowEffectView {
        let view = FridayWindowEffectView()
        view.material = .sidebar
        view.blendingMode = .behindWindow
        view.state = .followsWindowActiveState
        return view
    }

    func updateNSView(_ nsView: FridayWindowEffectView, context: Context) {}
}

private final class FridayWindowEffectView: NSVisualEffectView {
    private var buttonLayoutScheduled = false

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if let window {
            NotificationCenter.default.removeObserver(self, name: nil, object: window)
        }
        super.viewWillMove(toWindow: newWindow)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window else { return }
        window.styleMask.insert(.fullSizeContentView)
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.backgroundColor = .clear
        window.isOpaque = false
        for name in [NSWindow.didResizeNotification, NSWindow.didExitFullScreenNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(scheduleWindowButtonLayout), name: name, object: window)
        }
        scheduleWindowButtonLayout()
    }

    override func layout() {
        super.layout()
        scheduleWindowButtonLayout()
    }

    @objc private func scheduleWindowButtonLayout() {
        guard !buttonLayoutScheduled else { return }
        buttonLayoutScheduled = true
        // AppKit positions the title-bar buttons during its own layout pass first.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.buttonLayoutScheduled = false
            self.layoutWindowButtons()
        }
    }

    private func layoutWindowButtons() {
        guard let window, !window.styleMask.contains(.fullScreen) else { return }
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton]
            .compactMap { window.standardWindowButton($0) }
        guard buttons.count == 3, let container = buttons.first?.superview,
              buttons.allSatisfy({ $0.superview === container }) else { return }

        // Keep the native buttons and actions while compacting their size and spacing.
        let size = FridayTheme.trafficLightSize
        let groupWidth = size * CGFloat(buttons.count)
            + FridayTheme.trafficLightSpacing * CGFloat(buttons.count - 1)
        let center = container.convert(NSPoint(x: FridayTheme.sidebarWidth / 2, y: 0), from: nil).x
        var x = center - groupWidth / 2
        for button in buttons {
            if button.controlSize != .regular { button.controlSize = .regular }
            let frame = NSRect(x: x, y: button.frame.midY - size / 2, width: size, height: size)
            if button.frame != frame {
                button.frame = frame
            }
            // Scale the native 14-point artwork to the requested fractional size.
            let drawingBounds = NSRect(x: 0, y: 0, width: 14, height: 14)
            if button.bounds != drawingBounds {
                button.bounds = drawingBounds
            }
            x += size + FridayTheme.trafficLightSpacing
        }
    }
}

/// Keep text on a quiet surface, inset into the translucent window chrome.
struct FridayReadingSurface: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        content
            .background(FridayTheme.canvas)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(.primary.opacity(contrast == .increased ? 0.25 : 0.045), lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.12 : 0.04), radius: 10, x: 0, y: 3)
    }
}

struct FridayToolbarButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        FridayToolbarButtonBody(configuration: configuration)
    }
}

private struct FridayToolbarButtonBody: View {
    let configuration: ButtonStyleConfiguration
    @State private var hovering = false

    var body: some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: 15, weight: .regular))
            .foregroundStyle(.primary)
            .frame(width: 30, height: 28)
            .background {
                RoundedRectangle(cornerRadius: 6)
                    .fill(.primary.opacity(configuration.isPressed ? 0.12 : hovering ? 0.065 : 0))
            }
            .contentShape(RoundedRectangle(cornerRadius: 6))
            .onHover { hovering = $0 }
            .fridaySymbolFeedback(active: configuration.isPressed)
            .fridayInteractiveCursor()
    }
}
#endif

struct FridayButtonStyle: ButtonStyle {
    var prominent = false
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        FridayButtonBody(configuration: configuration, prominent: prominent, compact: compact)
    }
}

private struct FridayButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let prominent: Bool
    let compact: Bool
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        configuration.label
            .font(.system(compact ? .caption : .callout, weight: .medium))
            .padding(.horizontal, compact ? 11 : 15)
            .padding(.vertical, compact ? 7 : 10)
            .foregroundStyle(prominent ? FridayTheme.onAccent : configuration.role == .destructive ? .red : .primary)
            .background {
                RoundedRectangle(cornerRadius: compact ? 10 : 12)
                    .fill(prominent ? FridayTheme.accent : Color.primary.opacity(hovering ? 0.085 : 0.045))
            }
            .overlay {
                RoundedRectangle(cornerRadius: compact ? 10 : 12)
                    .strokeBorder(Color.primary.opacity(contrast == .increased ? 0.3 : 0.04))
            }
            .brightness(prominent && hovering && isEnabled ? 0.035 : 0)
            .opacity(isEnabled ? 1 : 0.4)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: configuration.isPressed)
            .onHover { hovering = $0 }
            .fridaySymbolFeedback(active: configuration.isPressed)
            .fridayInteractiveCursor()
    }
}

struct EmptyPanel: View {
    let icon: String
    let title: String
    let subtitle: String
    var body: some View {
        VStack(spacing: 14) {
            FridaySymbolImage(systemName: icon)
                .font(.system(size: 27, weight: .light))
                .foregroundStyle(FridayTheme.accent)
                .frame(width: 64, height: 64)
                .background(FridayTheme.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 22))
                .padding(.bottom, 4)
                .fridaySymbolFeedback()
                .accessibilityHidden(true)
            Text(fridayString: title).font(.title3.weight(.semibold))
            Text(fridayString: subtitle).font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).lineSpacing(4).frame(maxWidth: 310)
        }
        .padding(36).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct StatusBadge: View {
    let task: WorkItem
    var color: Color {
        switch task.status {
        case "completed": FridayTheme.accent
        case "waiting", "interrupted", "needs_project": .orange
        case "failed": .red
        case "running": .blue
        default: .secondary
        }
    }
    var body: some View {
        HStack(spacing: 5) {
            FridayTaskStatusIcon(status: task.status).frame(width: 12, height: 12)
            Text(fridayString: task.statusText)
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(color.opacity(0.09), in: Capsule()).foregroundStyle(color)
        .accessibilityElement(children: .combine)
    }
}
