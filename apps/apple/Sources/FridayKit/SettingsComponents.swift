import SwiftUI

struct SettingsPage<Content: View>: View {
    let title: String
    let subtitle: String
    let contentWidth: CGFloat
    private let content: Content

    init(title: String, subtitle: String, contentWidth: CGFloat = 680, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.contentWidth = contentWidth
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(fridayString: title).font(.system(size: 26, weight: .semibold))
                    Text(fridayString: subtitle).font(.system(size: 13)).foregroundStyle(FridayTheme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.bottom, 8)
                content
            }
            .frame(maxWidth: contentWidth, alignment: .leading)
            #if os(macOS)
            .padding(.horizontal, 36)
            .padding(.top, 52)
            #else
            .padding(.horizontal, 20)
            .padding(.top, 24)
            #endif
            .padding(.bottom, 48)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .foregroundStyle(FridayTheme.foreground)
        #if os(macOS)
        .background(FridayTheme.canvas)
        #else
        .background(FridayTheme.surface)
        #endif
    }
}

struct SettingsGroup<Content: View>: View {
    let title: String
    private let content: Content
    @Environment(\.colorSchemeContrast) private var contrast

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(fridayString: title).font(.system(size: 13, weight: .medium))
            VStack(alignment: .leading, spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(FridayTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay {
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(contrast == .increased ? FridayTheme.foreground.opacity(0.3) : FridayTheme.separator)
                        .allowsHitTesting(false)
                }
        }
    }
}

struct SettingsRow<Control: View>: View {
    private let title: Text
    let detail: String?
    private let control: Control

    init(_ title: String, detail: String? = nil, @ViewBuilder control: () -> Control) {
        self.title = Text(fridayString: title)
        self.detail = detail
        self.control = control()
    }

    init(verbatim title: String, detail: String? = nil, @ViewBuilder control: () -> Control) {
        self.title = Text(verbatim: title)
        self.detail = detail
        self.control = control()
    }

    private var layout: AnyLayout {
        #if os(macOS)
        AnyLayout(HStackLayout(alignment: .center, spacing: 20))
        #else
        AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
        #endif
    }

    var body: some View {
        layout {
            VStack(alignment: .leading, spacing: 4) {
                title.font(FridayTheme.interfaceFont)
                if let detail {
                    Text(fridayString: detail).font(.system(size: 12)).foregroundStyle(FridayTheme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            #if os(macOS)
            control.controlSize(.regular)
            #else
            control.controlSize(.small)
            #endif
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

struct SettingsDivider: View {
    var body: some View {
        Divider().overlay(FridayTheme.surface.opacity(0.45)).padding(.horizontal, 16)
    }
}

struct SettingsFieldChrome: ViewModifier {
    let width: CGFloat

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 10)
            .frame(width: width, height: 34)
            .background(FridayTheme.settingsMenuHover, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(FridayTheme.settingsSelectionBorder)
                    .allowsHitTesting(false)
            }
    }
}

struct SettingsMenuLabel: View {
    let value: String
    var width: CGFloat = 210

    var body: some View {
        HStack(spacing: 8) {
            Text(fridayString: value).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            FridaySymbolImage(systemName: "chevron.down")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(FridayTheme.settingsSelectionMuted)
        }
        .font(.system(size: 13))
        .foregroundStyle(FridayTheme.settingsSelectionForeground)
        .padding(.horizontal, 14)
        .frame(width: width, height: 32)
        .background {
            Capsule()
                .strokeBorder(FridayTheme.settingsSelectionBorder)
        }
        .contentShape(Capsule())
    }
}

#if os(macOS)
struct SettingsMenuSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(FridayTheme.settingsMenuSurface)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(FridayTheme.settingsSelectionBorder)
                    .allowsHitTesting(false)
            }
    }
}

struct SettingsMenuOption: View {
    let title: String
    let selected: Bool
    var highlighted = false
    let action: () -> Void
    @State private var hovered = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(fridayString: title).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                if selected {
                    FridaySymbolImage(systemName: "checkmark")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(FridayTheme.settingsSelectionMuted)
                }
            }
            .font(.system(size: 13))
            .foregroundStyle(FridayTheme.settingsSelectionForeground)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(hovered || highlighted ? FridayTheme.settingsMenuHover : .clear,
                        in: RoundedRectangle(cornerRadius: 7))
            .contentShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .opacity(isEnabled ? 1 : 0.5)
        .fridayInteractiveCursor()
        .onHover { hovered = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct SettingsChoiceList<Value: Hashable>: View {
    let options: [SettingsChoice<Value>]
    let selection: Value
    let choose: (Value) -> Void
    @State private var highlighted: Value?
    @FocusState private var focused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(options) { option in
                        SettingsMenuOption(title: option.title, selected: option.value == selection,
                                           highlighted: highlighted == option.value) {
                            choose(option.value)
                        }
                        .id(option.value)
                        .disabled(!option.isEnabled)
                        .accessibilityHint(Text(fridayString: option.hint ?? ""))
                        .onHover { if $0 && option.isEnabled { highlighted = option.value } }
                    }
                }
                .padding(4)
            }
            .focusable()
            .focusEffectDisabled()
            .focused($focused)
            .onAppear {
                highlighted = options.contains { $0.value == selection && $0.isEnabled } ? selection : options.first { $0.isEnabled }?.value
                focused = true
                if let highlighted { proxy.scrollTo(highlighted) }
            }
            .onChange(of: highlighted) { _, value in
                if let value { proxy.scrollTo(value) }
            }
            .onKeyPress(.downArrow) { move(1); return .handled }
            .onKeyPress(.upArrow) { move(-1); return .handled }
            .onKeyPress(.return) {
                activate()
                return .handled
            }
            .onKeyPress(.space) {
                activate()
                return .handled
            }
        }
    }

    private func activate() {
        if let highlighted, options.contains(where: { $0.value == highlighted && $0.isEnabled }) { choose(highlighted) }
    }

    private func move(_ delta: Int) {
        let enabled = options.filter(\.isEnabled)
        guard !enabled.isEmpty else { return }
        let index = highlighted.flatMap { value in enabled.firstIndex { $0.value == value } } ?? 0
        highlighted = enabled[min(max(index + delta, 0), enabled.count - 1)].value
    }
}
#endif

struct SettingsChoice<Value: Hashable>: Identifiable {
    let title: String
    let value: Value
    let isEnabled: Bool
    let hint: String?
    var id: Value { value }

    init(_ title: String, _ value: Value, isEnabled: Bool = true, hint: String? = nil) {
        self.title = title
        self.value = value
        self.isEnabled = isEnabled
        self.hint = hint
    }
}

struct SettingsSelect<Value: Hashable>: View {
    let title: String
    @Binding var selection: Value
    let options: [SettingsChoice<Value>]
    var width: CGFloat = 210
    var displayTitle: String? = nil
    @State private var showing = false

    private var selectedTitle: String {
        displayTitle ?? options.first { $0.value == selection }?.title ?? String(describing: selection)
    }

    var body: some View {
        #if os(macOS)
        Button { showing.toggle() } label: {
            SettingsMenuLabel(value: selectedTitle, width: width)
        }
        .buttonStyle(.plain)
        .fridayInteractiveCursor()
        .accessibilityLabel(Text(fridayString: title))
        .accessibilityValue(Text(fridayString: selectedTitle))
        .fridayDropdown(isPresented: $showing, width: max(width, 210),
                        height: min(CGFloat(options.count) * 32 + 8, 328)) {
            SettingsChoiceList(options: options, selection: selection) { value in
                selection = value
                showing = false
            }
        }
        #else
        Picker(selection: $selection) {
            ForEach(options) { option in
                Text(fridayString: option.title).tag(option.value)
                    .disabled(!option.isEnabled)
                    .accessibilityHint(Text(fridayString: option.hint ?? ""))
            }
        } label: { Text(fridayString: title) }
        .labelsHidden().pickerStyle(.menu).fridayInteractiveCursor()
        #endif
    }
}

struct SettingsIntegerField: View {
    let title: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    var width: CGFloat = 64
    @State private var draft: String
    @FocusState private var focused: Bool

    init(title: String, value: Binding<Int>, range: ClosedRange<Int>, width: CGFloat = 64) {
        self.title = title
        self._value = value
        self.range = range
        self.width = width
        self._draft = State(initialValue: String(value.wrappedValue))
    }

    var body: some View {
        #if os(macOS)
        TextField("", text: $draft)
            .textFieldStyle(.plain)
            .multilineTextAlignment(.trailing)
            .monospacedDigit()
            .focused($focused)
            .onSubmit(commit)
            .onChange(of: focused) { _, isFocused in if !isFocused { commit() } }
            .onChange(of: value) { _, newValue in if !focused { draft = String(newValue) } }
            .modifier(SettingsFieldChrome(width: width))
            .accessibilityLabel(Text(fridayString: title))
        #else
        Stepper(value: $value, in: range) { Text("\(value)").monospacedDigit() }
            .fixedSize().fridayInteractiveCursor().accessibilityLabel(Text(fridayString: title))
        #endif
    }

    private func commit() {
        if let parsed = Int(draft.trimmingCharacters(in: .whitespacesAndNewlines)) {
            value = min(max(parsed, range.lowerBound), range.upperBound)
        }
        draft = String(value)
    }
}
