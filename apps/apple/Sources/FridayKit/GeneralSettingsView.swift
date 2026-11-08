import SwiftUI

struct GeneralSettingsView: View {
    @AppStorage(FridayPreferenceKeys.language) private var language: FridayLanguage = .chinese
    @AppStorage("friday.composer.showSkillsInSlashMenu") private var showSkillsInSlashMenu = true

    var body: some View {
        SettingsPage(title: "通用", subtitle: "设置界面语言和输入习惯。") {
            SettingsGroup("语言") {
                SettingsRow("界面语言", detail: "立即生效，并在下次打开时保留。") {
                    Picker(selection: $language) {
                        ForEach(FridayLanguage.allCases) { option in
                            Text(verbatim: option.title).tag(option)
                        }
                    } label: { Text(friday: "界面语言") }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .fixedSize()
                    .fridayInteractiveCursor()
                }
            }
            SettingsGroup("任务输入框") {
                SettingsRow("在斜杠菜单中显示 Skill", detail: "关闭后仍可输入 $ 查找并选择可调用的 Skill。") {
                    Toggle(isOn: $showSkillsInSlashMenu) { Text(friday: "在斜杠菜单中显示 Skill") }
                        .labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
                }
            }
        }
    }
}
