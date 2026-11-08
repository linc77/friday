import SwiftUI

/// All application switches share the reference blue, including inactive windows.
struct FridayToggle<Label: View>: View {
    @Binding var isOn: Bool
    private let label: Label

    init(isOn: Binding<Bool>, @ViewBuilder label: () -> Label) {
        _isOn = isOn
        self.label = label()
    }

    var body: some View {
        Toggle(isOn: $isOn) { label }
            #if os(macOS)
            .toggleStyle(FridaySwitchStyle())
            #else
            .tint(FridayTheme.selectionAccent)
            #endif
    }
}

extension FridayToggle where Label == Text {
    init(_ title: String, isOn: Binding<Bool>) {
        self.init(isOn: isOn) { Text(fridayString: title) }
    }
}

#if os(macOS)
private struct FridaySwitchStyle: ToggleStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        LabeledContent {
            Button { configuration.isOn.toggle() } label: {
                Capsule()
                    .fill(configuration.isOn ? FridayTheme.selectionAccent : FridayTheme.switchTrackOff)
                    .frame(width: 34, height: 20)
                    .overlay(alignment: configuration.isOn ? .trailing : .leading) {
                        Circle().fill(.white).frame(width: 16, height: 16).padding(2)
                    }
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .fridayInteractiveCursor()
            .opacity(isEnabled ? 1 : 0.5)
            .accessibilityRepresentation {
                Toggle(isOn: configuration.$isOn) { configuration.label }
                    .toggleStyle(.switch)
            }
        } label: {
            configuration.label
        }
    }
}
#endif
