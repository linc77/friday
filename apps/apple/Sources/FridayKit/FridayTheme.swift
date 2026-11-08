import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum FridayTheme {
    static var accent: Color {
        if isMidnight { return color(0x3b6fcf) }
        #if os(macOS)
        return Color(nsColor: .labelColor)
        #else
        return Color(uiColor: .label)
        #endif
    }

    static var onAccent: Color {
        if isMidnight { return .white }
        #if os(macOS)
        return Color(nsColor: .textBackgroundColor)
        #else
        return Color(uiColor: .systemBackground)
        #endif
    }
    static let contentWidth: CGFloat = 780
    static let cornerRadius: CGFloat = 20
    static let motionResponse = 0.28
    static let motionDamping = 0.86
    static let motion = Animation.spring(response: motionResponse, dampingFraction: motionDamping)
    static var paneSpacing: CGFloat {
        #if os(macOS)
        windowEdgeInset
        #else
        0
        #endif
    }
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
        if isMidnight { return color(0x1c1e27) }
        #if os(macOS)
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? NSColor(white: 0.11, alpha: 1)
                : NSColor(white: 0.965, alpha: 1)
        })
        #else
        return Color(uiColor: .systemGroupedBackground)
        #endif
    }

    static var surface: Color {
        if isMidnight { return color(0x161820) }
        #if os(macOS)
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? NSColor(white: 0.15, alpha: 1)
                : NSColor.white
        })
        #else
        return Color(uiColor: .secondarySystemGroupedBackground)
        #endif
    }

    static var conversationCanvas: Color {
        if isMidnight { return color(0x1c1e27) }
        #if os(iOS)
        return Color(uiColor: .systemBackground)
        #else
        return Color(nsColor: .textBackgroundColor)
        #endif
    }

    static var conversationAssistantBackground: Color {
        if isMidnight { return color(0x252731) }
        #if os(macOS)
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? NSColor(white: 0.15, alpha: 1)
                : NSColor(red: 243.0 / 255.0, green: 243.0 / 255.0, blue: 245.0 / 255.0, alpha: 1)
        })
        #else
        return surface
        #endif
    }

    static var conversationUserBackground: Color {
        #if os(macOS)
        Color(red: 53.0 / 255.0, green: 99.0 / 255.0, blue: 244.0 / 255.0)
        #else
        conversationInput
        #endif
    }

    static var conversationUserForeground: Color {
        #if os(macOS)
        .white
        #else
        .primary
        #endif
    }

    static var conversationFont: Font {
        #if os(macOS)
        // Paseo desktop defaults: system sans, 15 px, weight 400.
        .system(size: 15, weight: .regular, design: .default)
        #else
        .body
        #endif
    }

    #if os(macOS)
    static let conversationLineSpacing: CGFloat = 4
    static let conversationParagraphSpacing: CGFloat? = 8
    static let conversationListItemSpacing: CGFloat? = 4
    static let conversationBubbleRadius: CGFloat = 24
    static let conversationUserLineSpacing: CGFloat = 4
    static let conversationUserBubbleRadius: CGFloat = 24
    static let conversationUserVerticalPadding: CGFloat = 10
    static let conversationAssistantHorizontalPadding: CGFloat = 18
    static let conversationAssistantVerticalPadding: CGFloat = 14
    #else
    static let conversationLineSpacing: CGFloat = 6
    static let conversationParagraphSpacing: CGFloat? = nil
    static let conversationListItemSpacing: CGFloat? = nil
    static let conversationBubbleRadius: CGFloat = cornerRadius
    static let conversationUserLineSpacing: CGFloat = 5
    static let conversationUserBubbleRadius: CGFloat = 16
    static let conversationUserVerticalPadding: CGFloat = 18
    static let conversationAssistantHorizontalPadding: CGFloat = 24
    static let conversationAssistantVerticalPadding: CGFloat = 24
    #endif

    static var conversationInput: Color {
        if isMidnight { return color(0x252731) }
        #if os(iOS)
        return Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor.secondarySystemBackground.resolvedColor(with: traits)
                : UIColor(white: 243.0 / 255.0, alpha: 1)
        })
        #else
        return accent.opacity(0.06)
        #endif
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
                    .strokeBorder(highlighted ? FridayTheme.accent.opacity(0.5) : (contrast == .increased ? FridayTheme.foreground.opacity(0.3) : FridayTheme.separator), lineWidth: 1)
            }
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.1 : 0.035), radius: 12, x: 0, y: 4)
    }
}

/// Glass belongs to the floating controls; reading surfaces stay opaque.
private struct FridayFloatingSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    @ViewBuilder func body(content: Content) -> some View {
        if FridayTheme.isMidnight || reduceTransparency || contrast == .increased {
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
    /// Independent macOS panes expose the shared window material in their gutters.
    @ViewBuilder func fridayPaneSurface(_ background: Color = FridayTheme.canvas, isContainer: Bool = false) -> some View {
        #if os(macOS)
        modifier(FridayReadingSurface(background: background, isContainer: isContainer))
        #else
        self
        #endif
    }

    func fridayCard(radius: CGFloat = FridayTheme.cornerRadius, highlighted: Bool = false) -> some View {
        modifier(FridayCard(radius: radius, highlighted: highlighted))
    }

    func fridayFloatingSurface() -> some View {
        modifier(FridayFloatingSurface())
    }
}

#if os(macOS)
/// One continuous native material behind the rail and window edges.
struct FridayWindowBackground: View {
    var configuresWindow = true
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        FridayWindowVisualEffect(configuresWindow: configuresWindow)
            .overlay {
                if reduceTransparency || contrast == .increased {
                    if FridayTheme.isMidnight {
                        FridayTheme.sidebarBackground
                    } else {
                        Color(nsColor: .windowBackgroundColor)
                    }
                } else if FridayTheme.isMidnight {
                    // Tint the native material without hiding its backdrop blur.
                    FridayTheme.sidebarBackground.opacity(0.80)
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

private struct FridayWindowVisualEffect: NSViewRepresentable {
    let configuresWindow: Bool

    func makeNSView(context: Context) -> FridayWindowEffectView {
        let view = FridayWindowEffectView()
        view.configuresWindow = configuresWindow
        view.material = .sidebar
        view.blendingMode = .behindWindow
        view.state = .followsWindowActiveState
        return view
    }

    func updateNSView(_ nsView: FridayWindowEffectView, context: Context) {
        nsView.configuresWindow = configuresWindow
    }
}

private final class FridayWindowEffectView: NSVisualEffectView {
    var configuresWindow = true
    private var buttonLayoutScheduled = false

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if configuresWindow, let window {
            NotificationCenter.default.removeObserver(self, name: nil, object: window)
        }
        super.viewWillMove(toWindow: newWindow)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard configuresWindow else { return }
        guard let window else { return }
        if #available(macOS 15.0, *), window.styleMask.contains(.titled) {
            // Changing the style rebuilds AppKit's frame view. Wait until the
            // current attachment finishes, then let viewDidMoveToWindow configure it.
            DispatchQueue.main.async { [weak self, weak window] in
                guard let window, window.styleMask.contains(.titled) else { return }
                window.styleMask.remove(.titled)
                window.isMovableByWindowBackground = true
                window.collectionBehavior.insert(.fullScreenPrimary)
                self?.scheduleWindowButtonLayout()
            }
        }
        if window.styleMask.contains(.titled) {
            window.styleMask.insert(.fullSizeContentView)
        } else {
            window.styleMask.formUnion([.closable, .miniaturizable, .resizable])
            window.collectionBehavior.insert(.fullScreenPrimary)
        }
        // Keep the workspace name in the window list without adding a title to the custom rail.
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.backgroundColor = .clear
        window.isOpaque = false
        // WindowServer's shadow can include a thin rim even on borderless windows.
        window.hasShadow = false
        for name in [NSWindow.didResizeNotification, NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(scheduleWindowButtonLayout), name: name, object: window)
        }
        scheduleWindowButtonLayout()
    }

    override func layout() {
        super.layout()
        scheduleWindowButtonLayout()
    }

    @objc private func scheduleWindowButtonLayout() {
        guard configuresWindow, !buttonLayoutScheduled else { return }
        buttonLayoutScheduled = true
        // AppKit positions the title-bar buttons during its own layout pass first.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.buttonLayoutScheduled = false
            self.layoutWindowButtons()
        }
    }

    private func layoutWindowButtons() {
        guard let window else { return }
        if window.hasShadow { window.hasShadow = false }
        if !window.styleMask.contains(.titled) {
            // Plain windows have no system rim; clip their content instead of
            // drawing a replacement border. Keep full-screen corners square.
            window.contentView?.wantsLayer = true
            window.contentView?.layer?.cornerRadius = window.styleMask.contains(.fullScreen) ? 0 : 14
            window.contentView?.layer?.cornerCurve = .continuous
            window.contentView?.layer?.masksToBounds = true
            return
        }
        guard !window.styleMask.contains(.fullScreen) else { return }
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
    var background: Color = FridayTheme.canvas
    var isContainer = false
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        if isContainer {
            content
        } else {
            content
                .background(background)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay {
                    if contrast == .increased {
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(.primary.opacity(0.25), lineWidth: 1)
                            .allowsHitTesting(false)
                    }
                }
        }
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

    var body: some View {
        configuration.label
            .font(.system(compact ? .caption : .callout, weight: .medium))
            .padding(.horizontal, compact ? 11 : 15)
            .padding(.vertical, compact ? 7 : 10)
            #if os(macOS)
            .foregroundStyle(configuration.role == .destructive ? .red : FridayTheme.foreground)
            .background {
                RoundedRectangle(cornerRadius: compact ? 10 : 12)
                    .fill(FridayTheme.sidebarBackground)
                    .overlay {
                        RoundedRectangle(cornerRadius: compact ? 10 : 12)
                            .fill(FridayTheme.foreground.opacity(configuration.isPressed ? 0.14 : hovering && isEnabled ? 0.09 : prominent ? 0.05 : 0))
                    }
            }
            #else
            .foregroundStyle(prominent ? FridayTheme.onAccent : configuration.role == .destructive ? .red : FridayTheme.foreground)
            .background {
                RoundedRectangle(cornerRadius: compact ? 10 : 12)
                    .fill(prominent ? FridayTheme.accent : Color.primary.opacity(hovering ? 0.085 : 0.045))
            }
            .brightness(prominent && hovering && isEnabled ? 0.035 : 0)
            #endif
            .opacity(isEnabled ? 1 : 0.4)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: configuration.isPressed)
            .onHover { hovering = $0 }
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
