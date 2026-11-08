import SwiftUI

struct GeneralSettingsView: View {
    @AppStorage(FridayPreferenceKeys.language) private var language: FridayLanguage = .chinese
    @AppStorage("friday.composer.showSkillsInSlashMenu") private var showSkillsInSlashMenu = true

    var body: some View {
        SettingsPage(title: "通用", subtitle: "设置界面语言和输入习惯。") {
            SettingsGroup("语言") {
                SettingsRow("界面语言", detail: "立即生效，并在下次打开时保留。") {
                    SettingsSelect(title: "界面语言", selection: $language,
                        options: FridayLanguage.allCases.map { SettingsChoice($0.title, $0) }, width: 160)
                }
            }
            SettingsGroup("任务输入框") {
                SettingsRow("在斜杠菜单中显示 Skill", detail: "关闭后仍可输入 $ 查找并选择可调用的 Skill。") {
                    FridayToggle(isOn: $showSkillsInSlashMenu) { Text(friday: "在斜杠菜单中显示 Skill") }
                        .labelsHidden().fridayInteractiveCursor()
                }
            }
        }
    }
}
