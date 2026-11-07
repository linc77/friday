#if os(macOS)
import SwiftUI

private struct FridayModelJumpKey: EnvironmentKey {
    static let defaultValue: Binding<TaskModelJumpContext?> = .constant(nil)
}
private struct FridayTitleEditorsKey: EnvironmentKey {
    static let defaultValue: Binding<Set<UUID>> = .constant([])
}
extension EnvironmentValues {
    var fridayModelJump: Binding<TaskModelJumpContext?> {
        get { self[FridayModelJumpKey.self] }
        set { self[FridayModelJumpKey.self] = newValue }
    }
    var fridayTitleEditors: Binding<Set<UUID>> {
        get { self[FridayTitleEditorsKey.self] }
        set { self[FridayTitleEditorsKey.self] = newValue }
    }
}

struct TaskTitleKeyboardGuard: ViewModifier {
    let token: UUID?
    @Environment(\.fridayTitleEditors) private var editors
    func body(content: Content) -> some View {
        content.onChange(of: token, initial: true) { old, new in
            var tokens = editors.wrappedValue
            if let old { tokens.remove(old) }; if let new { tokens.insert(new) }
            if tokens != editors.wrappedValue { editors.wrappedValue = tokens }
        }.onDisappear {
            if let token { editors.wrappedValue.remove(token) }
        }
    }
}

private struct FridayTaskNavigationKey: FocusedValueKey { typealias Value = TaskNavigationActions }
extension FocusedValues {
    var fridayTaskNavigation: TaskNavigationActions? {
        get { self[FridayTaskNavigationKey.self] }
        set { self[FridayTaskNavigationKey.self] = newValue }
    }
}

struct FridayTaskCommands: Commands {
    @FocusedValue(\.fridayTaskNavigation) private var navigation
    @AppStorage(FridayPreferenceKeys.language) private var language: FridayLanguage = .chinese
    var body: some Commands {
        CommandMenu(String(localized: "任务", bundle: .module, locale: language.locale)) {
            Button(friday: "搜索任务…") { navigation?.search?() }.disabled(navigation?.search == nil).environment(\.locale, language.locale)
            Divider()
            Button(friday: "上一个任务") { if let navigation, let id = navigation.previous { navigation.open(id) } }
                .keyboardShortcut("[", modifiers: [.command, .shift]).disabled(navigation?.previous == nil)
                .environment(\.locale, language.locale)
            Button(friday: "下一个任务") { if let navigation, let id = navigation.next { navigation.open(id) } }
                .keyboardShortcut("]", modifiers: [.command, .shift]).disabled(navigation?.next == nil)
                .environment(\.locale, language.locale)
            Divider()
            ForEach(0..<9, id: \.self) { index in
                Button { navigation?.jump(index) } label: {
                    if let title = navigation?.title(index) { Text(verbatim: "\(index + 1) · \(title)") }
                    else { Text(friday: "跳转到第 \(index + 1) 个任务") }
                }
                .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                .disabled(navigation?.enabled(index) != true)
                .environment(\.locale, language.locale)
            }
        }
    }
}
#endif
