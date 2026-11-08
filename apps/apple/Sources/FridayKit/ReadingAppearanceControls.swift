import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct ReadingAppearanceControls: View {
    @ReadingPreferences private var reading: ReadingStyle
    private static var families: [String] {
        #if os(macOS)
        NSFontManager.shared.availableFontFamilies.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        #else
        UIFont.familyNames.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        #endif
    }
    @State private var families = Self.families

    var body: some View {
        SettingsGroup("字体") {
            SettingsRow("正文字体", detail: "用于对话正文、Markdown 和消息输入；中文使用所选字体或系统回退字体。") {
                familyPicker("正文字体", selection: $reading.bodyFamily)
            }
            SettingsDivider()
            SettingsRow("正文字号") {
                Stepper(value: $reading.bodySize, in: 12...24, step: 1) {
                    Text("\(Int(reading.bodySize)) pt").monospacedDigit()
                }.fixedSize().fridayInteractiveCursor().accessibilityLabel(Text(friday: "正文字号"))
            }
            SettingsDivider()
            SettingsRow("代码字体", detail: "用于代码块和源码预览，建议选择等宽字体。") {
                familyPicker("代码字体", selection: $reading.codeFamily)
            }
            SettingsDivider()
            SettingsRow("代码字号") {
                Stepper(value: $reading.codeSize, in: 10...22, step: 1) {
                    Text("\(Int(reading.codeSize)) pt").monospacedDigit()
                }.fixedSize().fridayInteractiveCursor().accessibilityLabel(Text(friday: "代码字号"))
            }
        }
        SettingsGroup("内容布局") {
            SettingsRow("使用全宽", detail: "让对话内容与输入框填满可用宽度，并保留两侧边距。") {
                Toggle(isOn: Binding(get: { reading.width == 0 }, set: { reading.width = $0 ? 0 : 780 })) {
                    Text(friday: "使用全宽")
                }.labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
            }
            if reading.width != 0 {
                SettingsDivider()
                SettingsRow("内容最大宽度", detail: "窄窗口会自动收缩，不影响设置页和工具面板。") {
                    Stepper(value: $reading.width, in: 560...1600, step: 40) {
                        Text("\(Int(reading.width)) pt").monospacedDigit()
                    }.fixedSize().fridayInteractiveCursor().accessibilityLabel(Text(friday: "内容最大宽度"))
                }
            }
        }
        SettingsGroup("代码主题配色") {
            SettingsRow("语法高亮主题", detail: "用于代码块和源码预览，自动匹配界面的浅色或深色模式。") {
                Picker(selection: $reading.codeTheme) {
                    ForEach(CodeColorTheme.allCases) { Text(verbatim: $0.title).tag($0) }
                } label: { Text(friday: "语法高亮主题") }
                .labelsHidden().pickerStyle(.menu).fridayInteractiveCursor()
            }
        }
        VStack(alignment: .leading, spacing: 12) {
            Text(friday: "实时预览").font(.system(size: 13, weight: .medium))
            Text(friday: "Friday 帮你把想法变成行动。The quick brown fox jumps over the lazy dog.")
                .font(reading.bodyFont).foregroundStyle(FridayTheme.foreground).lineSpacing(reading.lineSpacing).textSelection(.enabled)
            AgentCodeBlock(language: "typescript", text: "// Friday · Hello world\ninterface Task { title: string; done: boolean }\nconst task: Task = { title: \"你好，Friday\", done: false };\nfunction describe(task: Task) {\n  return task.done ? \"完成\" : task.title;\n}")
            Text(friday: "更改立即生效，并保存在这台设备上。")
                .font(.caption).foregroundStyle(FridayTheme.secondaryText)
            Button(friday: "恢复阅读外观默认值") { reading = ReadingStyle() }
                .buttonStyle(FridayButtonStyle(compact: true))
        }
    }

    private func familyPicker(_ title: String, selection: Binding<String>) -> some View {
        Picker(selection: selection) {
            Text(friday: "系统默认").tag("")
            if !selection.wrappedValue.isEmpty, !families.contains(selection.wrappedValue) {
                Text(verbatim: selection.wrappedValue).tag(selection.wrappedValue)
            }
            ForEach(families, id: \.self) { Text(verbatim: $0).tag($0) }
        } label: { Text(fridayString: title) }
        .labelsHidden().pickerStyle(.menu).frame(maxWidth: 240).fridayInteractiveCursor()
    }
}
