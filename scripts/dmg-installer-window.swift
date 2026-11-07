import AppKit
import SwiftUI

struct DmgInstallerWindow: View {
    @ObservedObject var model: DmgInstallerDelegate

    var body: some View {
        GeometryReader { geometry in
            let iconSize = min(220, max(128, min(geometry.size.width * 0.27, geometry.size.height * 0.40)))
            ZStack {
                InstallerBackdrop()
                ScrollView {
                    VStack(spacing: 0) {
                        InstallerIcon(
                            enabled: !model.busy, actionLabel: model.actionLabel,
                            action: model.activate
                        )
                        .frame(width: iconSize, height: iconSize)
                        .clipped()
                        Text(model.productName)
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(Color(white: 0.08))
                            .padding(.top, 10)
                        VStack(spacing: 10) {
                            Text(model.headline)
                                .font(.system(size: min(28, max(20, geometry.size.width / 28)), weight: .medium))
                                .foregroundStyle(.white)
                            Text(model.message)
                                .font(.system(size: 14))
                                .foregroundStyle(Color(white: 0.88))
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 540)
                        .padding(.top, 28)
                    }
                    .padding(28)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                }
                .scrollIndicators(.hidden)
            }
        }
        .preferredColorScheme(.light)
    }
}

// Every frame is painted using the actual view bounds. The gradient's normalized
// coordinates preserve the composition for wide, tall and full-screen windows.
private struct InstallerBackdrop: View {
    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(white: 0.98)))
            context.scaleBy(x: size.width / 600, y: size.height / 360)
            context.fill(
                Path(CGRect(x: 0, y: 0, width: 600, height: 360)),
                with: .radialGradient(
                    Gradient(stops: [
                        .init(color: .black.opacity(0.98), location: 0),
                        .init(color: .black.opacity(0.92), location: 0.20),
                        .init(color: .black.opacity(0.67), location: 0.45),
                        .init(color: .black.opacity(0.25), location: 0.70),
                        .init(color: .clear, location: 1),
                    ]),
                    center: CGPoint(x: 300, y: 420), startRadius: 0, endRadius: 340
                )
            )
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

private struct InstallerIcon: NSViewRepresentable {
    let enabled: Bool
    let actionLabel: String
    let action: () -> Void

    func makeNSView(context: Context) -> InstallerIconButton {
        let button = InstallerIconButton()
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.imageScaling = .scaleProportionallyUpOrDown
        button.image = Bundle.main.url(forResource: "Friday", withExtension: "icns").flatMap(NSImage.init(contentsOf:))
        // ICNS includes a 1024 px representation. Its natural size must not become
        // the AppKit control's minimum size inside the smaller SwiftUI frame.
        button.image?.size = NSSize(width: 128, height: 128)
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        button.setContentHuggingPriority(.defaultLow, for: .vertical)
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        button.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        button.setButtonType(.momentaryChange)
        (button.cell as? NSButtonCell)?.highlightsBy = []
        button.focusRingType = .exterior
        button.keyEquivalent = "\r"
        button.target = button
        button.action = #selector(InstallerIconButton.activate)
        return button
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: InstallerIconButton, context: Context) -> CGSize? {
        // Honor the 128–220 pt square selected by the responsive parent, rather
        // than deriving a size from NSButtonCell's image-based intrinsic metrics.
        CGSize(width: proposal.width ?? 128, height: proposal.height ?? 128)
    }

    func updateNSView(_ button: InstallerIconButton, context: Context) {
        button.isEnabled = enabled
        button.onActivate = action
        button.setAccessibilityLabel(actionLabel)
        button.setAccessibilityHelp("双击图标，或按 Return 键" + actionLabel)
        button.toolTip = enabled ? "双击图标，或按 Return 键" + actionLabel : nil
        button.window?.invalidateCursorRects(for: button)
    }
}

// A native control keeps keyboard/VoiceOver activation while matching the
// reference's double-click gesture. The brand image itself stays static.
private final class InstallerIconButton: NSButton {
    var onActivate: (() -> Void)?

    @objc func activate() { if isEnabled { onActivate?() } }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        window?.makeFirstResponder(self)
        if event.clickCount == 2 { performClick(nil) }
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        if isEnabled { addCursorRect(bounds, cursor: .pointingHand) }
    }
}
