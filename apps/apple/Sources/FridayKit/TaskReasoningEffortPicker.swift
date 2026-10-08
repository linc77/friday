import SwiftUI

struct TaskReasoningEffortControl: View {
    @Binding var selection: String
    let efforts: [String]
    let defaultEffort: String
    @State private var presented = false
    @Environment(\.locale) private var locale
    @Environment(\.isEnabled) private var isEnabled

    private var currentEffort: String { selection.isEmpty ? defaultEffort : selection }
    private var currentLabel: Text { label(for: currentEffort) }

    private func label(for effort: String) -> Text {
        effort.isEmpty ? Text(friday: "默认") : Text(effort == "xhigh" ? "XHigh" : effort.capitalized)
    }

    var body: some View {
        Button { presented.toggle() } label: {
            // Reserve the widest option so selection changes cannot move the popover anchor.
            ZStack(alignment: .leading) {
                ForEach(efforts.isEmpty ? [""] : efforts, id: \.self) { value in
                    label(for: value)
                }
            }
            .lineLimit(1)
            .fixedSize()
            .hidden()
            .accessibilityHidden(true)
            .overlay(alignment: .leading) { currentLabel.lineLimit(1) }
            .contentShape(Rectangle())
        }
        .buttonStyle(FridaySymbolButtonStyle())
        .disabled(efforts.isEmpty)
        .accessibilityLabel(Text(friday: "推理强度"))
        .accessibilityValue(currentLabel)
        .popover(isPresented: $presented) {
            VStack(alignment: .leading, spacing: 12) {
                Text(friday: "推理强度").font(.headline)
                TaskReasoningEffortPicker(selection: $selection, efforts: efforts, defaultEffort: defaultEffort)
                    .disabled(!isEnabled)
            }
            .padding(16).environment(\.locale, locale)
        }
        .onChange(of: isEnabled) { _, enabled in if !enabled { presented = false } }
    }
}

/// Use native Liquid Glass for the lens, with continuous dragging between the
/// discrete model values. Buttons retain keyboard and VoiceOver activation.
struct TaskReasoningEffortPicker: View {
    @Binding var selection: String
    let efforts: [String]
    let defaultEffort: String
    @GestureState private var dragX: CGFloat?
    @FocusState private var focused: String?
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.scenePhase) private var scenePhase

    private let segmentWidth: CGFloat = 56
    private let inset: CGFloat = 3
    private var values: [String] { efforts }
    private var enabled: Bool { isEnabled && !efforts.isEmpty }
    private var currentEffort: String { selection.isEmpty ? defaultEffort : selection }
    private var selectedIndex: Int? { values.firstIndex(of: currentEffort) }
    private var previewIndex: Int? { dragX.map(index(at:)) ?? selectedIndex }
    private var lensX: CGFloat {
        guard let dragX else { return CGFloat(selectedIndex ?? 0) * segmentWidth }
        return min(max(dragX - inset - segmentWidth / 2, 0), CGFloat(max(values.count - 1, 0)) * segmentWidth)
    }

    var body: some View {
        ZStack(alignment: .leading) {
            Capsule().fill(Color.primary.opacity(0.045))
                .overlay(Capsule().strokeBorder(Color.primary.opacity(contrast == .increased ? 0.3 : 0.06)))
                .allowsHitTesting(false)
            if previewIndex != nil {
                lens.frame(width: segmentWidth, height: 28)
                    .offset(x: inset + lensX)
                    .allowsHitTesting(false)
                    .animation(dragX == nil && !reduceMotion && scenePhase == .active ? .smooth(duration: 0.2) : nil, value: lensX)
            }
            HStack(spacing: 0) {
                ForEach(Array(values.enumerated()), id: \.element) { index, value in
                    Button { selection = value; focused = value } label: {
                        Text(title(value))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(previewIndex == index ? Color.primary : .secondary)
                            .frame(width: segmentWidth, height: 28)
                            .contentShape(Capsule())
                            .overlay(Capsule().strokeBorder(focused == value ? Color.primary.opacity(0.35) : .clear))
                    }
                    .buttonStyle(FridaySymbolButtonStyle()).focused($focused, equals: value).focusEffectDisabled()
                    .accessibilityLabel(Text(title(value)))
                    .accessibilityAddTraits(selectedIndex == index ? .isSelected : [])
                    .help(Text(title(value)))
                }
            }.padding(inset)
        }
        .frame(width: CGFloat(values.count) * segmentWidth + inset * 2, height: 34)
        .contentShape(Capsule())
        .highPriorityGesture(DragGesture(minimumDistance: 3)
            .updating($dragX) { value, position, _ in
                if enabled { position = value.location.x }
            }
            .onEnded { value in
                if enabled { selection = values[index(at: value.location.x)] }
            })
        .fridayInteractiveCursor()
        .disabled(!enabled).opacity(enabled ? 1 : 0.45)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(friday: "推理强度"))
        .onAppear { focused = values.contains(currentEffort) ? currentEffort : nil }
        .onChange(of: currentEffort) { _, value in
            if focused != nil { focused = values.contains(value) ? value : nil }
        }
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: moveSelection(1)
            case .decrement: moveSelection(-1)
            @unknown default: break
            }
        }
        #if os(macOS)
        .onMoveCommand { direction in
            if direction == .left { moveSelection(-1) }
            if direction == .right { moveSelection(1) }
        }
        #endif
    }

    @ViewBuilder private var lens: some View {
        if reduceTransparency || contrast == .increased {
            Capsule().fill(FridayTheme.surface)
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.25)))
        } else {
            #if compiler(>=6.2)
            if #available(macOS 26.0, iOS 26.0, *) {
                Color.clear.glassEffect(.regular, in: Capsule())
            } else {
                materialLens
            }
            #else
            materialLens
            #endif
        }
    }

    private var materialLens: some View {
        Capsule().fill(.regularMaterial)
            .overlay(Capsule().strokeBorder(Color.primary.opacity(0.08)))
            .shadow(color: .black.opacity(0.08), radius: 3, y: 1)
    }

    private func index(at x: CGFloat) -> Int {
        min(max(Int((x - inset) / segmentWidth), 0), max(values.count - 1, 0))
    }

    private func moveSelection(_ step: Int) {
        guard enabled else { return }
        selection = values[min(max(selectedIndex.map { $0 + step } ?? 0, 0), values.count - 1)]
        if focused != nil { focused = selection }
    }

    private func title(_ value: String) -> String {
        value == "xhigh" ? "XHigh" : value.capitalized
    }
}
