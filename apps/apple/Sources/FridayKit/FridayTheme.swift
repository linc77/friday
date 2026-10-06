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
        Image(systemName: "sparkle")
            .font(.system(size: size * 0.52, weight: .medium))
            .foregroundStyle(FridayTheme.accent)
            .frame(width: size, height: size)
            .background(FridayTheme.accent.opacity(0.09), in: RoundedRectangle(cornerRadius: size * 0.32))
            .fridaySymbolFeedback(.pulse)
            .accessibilityHidden(true)
    }
}

struct PageHeading: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title).font(.largeTitle.weight(.semibold)).tracking(-0.6)
            Text(subtitle).font(.callout).foregroundStyle(.secondary).lineSpacing(4)
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
struct FridayToolbarButtonStyle: ButtonStyle {
    var motion: FridaySymbolMotion = .bounce

    func makeBody(configuration: Configuration) -> some View {
        FridayToolbarButtonBody(configuration: configuration, motion: motion)
    }
}

private struct FridayToolbarButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let motion: FridaySymbolMotion
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovering)
            .onHover { hovering = $0 }
            .fridaySymbolFeedback(motion, active: configuration.isPressed)
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
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: hovering)
            .onHover { hovering = $0 }
            .fridaySymbolFeedback(active: configuration.isPressed)
    }
}

struct EmptyPanel: View {
    let icon: String
    let title: String
    let subtitle: String
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 27, weight: .light))
                .foregroundStyle(FridayTheme.accent)
                .frame(width: 64, height: 64)
                .background(FridayTheme.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 22))
                .padding(.bottom, 4)
                .fridaySymbolFeedback(icon == "scribble" ? .wiggle : .bounce)
                .accessibilityHidden(true)
            Text(title).font(.title3.weight(.semibold))
            Text(subtitle).font(.callout).foregroundStyle(.secondary)
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
            Text(task.statusText)
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(color.opacity(0.09), in: Capsule()).foregroundStyle(color)
        .accessibilityElement(children: .combine)
    }
}
