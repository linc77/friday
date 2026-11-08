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
                numberField("正文字号", value: $reading.bodySize, range: 12...24)
            }
            SettingsDivider()
            SettingsRow("代码字体", detail: "用于代码块和源码预览，建议选择等宽字体。") {
                familyPicker("代码字体", selection: $reading.codeFamily)
            }
            SettingsDivider()
            SettingsRow("代码字号") {
                numberField("代码字号", value: $reading.codeSize, range: 10...22)
            }
        }
        SettingsGroup("内容布局") {
            SettingsRow("使用全宽", detail: "让对话内容与输入框填满可用宽度，并保留两侧边距。") {
                FridayToggle(isOn: Binding(get: { reading.width == 0 }, set: { reading.width = $0 ? 0 : 780 })) {
                    Text(friday: "使用全宽")
                }.labelsHidden().fridayInteractiveCursor()
            }
            if reading.width != 0 {
                SettingsDivider()
                SettingsRow("内容最大宽度", detail: "窄窗口会自动收缩，不影响设置页和工具面板。") {
                    numberField("内容最大宽度", value: $reading.width, range: 560...1600, step: 40, width: 80)
                }
            }
        }
        SettingsGroup("代码主题配色") {
            SettingsRow("语法高亮主题", detail: "用于代码块和源码预览，自动匹配界面的浅色或深色模式。") {
                SettingsSelect(title: "语法高亮主题", selection: $reading.codeTheme,
                    options: CodeColorTheme.allCases.map { SettingsChoice($0.title, $0) }, width: 240)
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
        #if os(macOS)
        ReadingFontPicker(title: title, selection: selection, families: families)
        #else
        Picker(selection: selection) {
            Text(friday: "系统默认").tag("")
            if !selection.wrappedValue.isEmpty, !families.contains(selection.wrappedValue) {
                Text(verbatim: selection.wrappedValue).tag(selection.wrappedValue)
            }
            ForEach(families, id: \.self) { Text(verbatim: $0).tag($0) }
        } label: { Text(fridayString: title) }
        .labelsHidden().pickerStyle(.menu).frame(maxWidth: 240).fridayInteractiveCursor()
        #endif
    }

    private func numberField(_ title: String, value: Binding<Double>, range: ClosedRange<Int>, step: Double = 1, width: CGFloat = 64) -> some View {
        #if os(macOS)
        ReadingNumberField(title: title, value: value, range: range, width: width)
        #else
        Stepper(value: value, in: Double(range.lowerBound)...Double(range.upperBound), step: step) {
            Text("\(Int(value.wrappedValue)) pt").monospacedDigit()
        }
        .fixedSize().fridayInteractiveCursor().accessibilityLabel(Text(fridayString: title))
        #endif
    }
}

#if os(macOS)
private struct ReadingFontPicker: View {
    let title: String
    @Binding var selection: String
    let families: [String]
    @State private var showing = false
    @State private var search = ""

    private var matches: [String] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return families }
        return families.filter { $0.localizedStandardContains(query) }
    }

    var body: some View {
        Button {
            search = ""
            showing = true
        } label: {
            SettingsMenuLabel(value: selection.isEmpty ? "系统默认" : selection, width: 240)
        }
        .buttonStyle(.plain)
        .fridayInteractiveCursor()
        .accessibilityLabel(Text(fridayString: title))
        .accessibilityValue(Text(fridayString: selection.isEmpty ? "系统默认" : selection))
        .fridayDropdown(isPresented: $showing, width: 280, height: 320) {
            VStack(spacing: 0) {
                TextField(friday: "搜索字体", text: $search)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 10)
                    .frame(height: 32)
                    .background(FridayTheme.settingsMenuHover, in: RoundedRectangle(cornerRadius: 7))
                    .padding(8)
                Divider().overlay(FridayTheme.settingsSelectionBorder)
                ScrollView {
                    LazyVStack(spacing: 0) {
                        option("", label: "系统默认")
                        if !selection.isEmpty && !families.contains(selection) {
                            option(selection, label: selection)
                        }
                        ForEach(matches, id: \.self) { family in
                            option(family, label: family)
                        }
                    }
                    .padding(6)
                }
            }
        }
    }

    private func option(_ value: String, label: String) -> some View {
        SettingsMenuOption(title: label, selected: selection == value) {
            selection = value
            showing = false
        }
    }
}

private struct ReadingNumberField: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Int>
    let width: CGFloat
    @State private var draft: String
    @FocusState private var focused: Bool

    init(title: String, value: Binding<Double>, range: ClosedRange<Int>, width: CGFloat) {
        self.title = title
        self._value = value
        self.range = range
        self.width = width
        self._draft = State(initialValue: String(Int(value.wrappedValue)))
    }

    var body: some View {
        HStack(spacing: 8) {
            TextField("", text: $draft)
                .textFieldStyle(.plain)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
                .focused($focused)
                .onSubmit(commit)
                .onChange(of: focused) { _, isFocused in
                    if !isFocused { commit() }
                }
                .onChange(of: value) { _, newValue in
                    if !focused { draft = String(Int(newValue)) }
                }
                .modifier(SettingsFieldChrome(width: width))
                .accessibilityLabel(Text(fridayString: title))
            Text(verbatim: "pt")
                .font(.system(size: 13))
                .foregroundStyle(FridayTheme.secondaryText)
        }
    }

    private func commit() {
        if let parsed = Double(draft.trimmingCharacters(in: .whitespacesAndNewlines)), parsed.isFinite {
            value = min(max(parsed.rounded(), Double(range.lowerBound)), Double(range.upperBound))
        }
        draft = String(Int(value))
    }
}
#endif
