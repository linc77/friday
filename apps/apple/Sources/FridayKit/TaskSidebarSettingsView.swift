import SwiftUI

struct TaskSidebarSettingsRows: View {
    @AppStorage(FridayPreferenceKeys.legacySidebar) private var legacySidebar = false
    @AppStorage(FridayPreferenceKeys.projectGrouping) private var grouping: TaskProjectGrouping = .repository
    @AppStorage(FridayPreferenceKeys.projectSort) private var projectSort: TaskProjectSort = .updated
    @AppStorage(FridayPreferenceKeys.threadSort) private var threadSort: TaskThreadSort = .updated
    @AppStorage(FridayPreferenceKeys.threadPreviewCount) private var count = 6
    var body: some View {
        SettingsRow("项目分组", detail: "将同一仓库的 Workspace 合并；可在 Workspace 设置中单独覆盖。") {
            Picker(selection: $grouping) { ForEach(TaskProjectGrouping.allCases) { Text(fridayString: $0.title).tag($0) } } label: { Text(friday: "项目分组") }
                .labelsHidden().pickerStyle(.menu).fridayInteractiveCursor()
        }
        SettingsDivider()
        SettingsRow("项目顺序", detail: "用于项目筛选器和项目树；手动顺序可在旧版项目树中拖动调整。") {
            Picker(selection: $projectSort) { ForEach(TaskProjectSort.allCases) { Text(fridayString: $0.title).tag($0) } } label: { Text(friday: "项目顺序") }
                .labelsHidden().pickerStyle(.menu).fridayInteractiveCursor()
        }
        SettingsDivider()
        SettingsRow("旧版项目树", detail: "按项目展开任务，替代默认的扁平任务分组。") {
            Toggle(isOn: $legacySidebar) { Text(friday: "旧版项目树") }.labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
        }
        if legacySidebar {
            SettingsDivider()
            SettingsRow("项目内任务顺序", detail: "最近发送按最新用户消息排序，流式输出不会改变顺序。") {
                Picker(selection: $threadSort) { ForEach(TaskThreadSort.allCases) { Text(fridayString: $0.title).tag($0) } } label: { Text(friday: "项目内任务顺序") }
                    .labelsHidden().pickerStyle(.menu).fridayInteractiveCursor()
            }
            SettingsDivider()
            SettingsRow("默认显示任务数", detail: "每个项目默认显示 1–15 条任务，可展开完整列表。") {
                Stepper(value: $count, in: 1...15) { Text("\(max(1,min(15,count)))").monospacedDigit() }.fixedSize().fridayInteractiveCursor()
            }
        }
    }
}
struct TaskProjectGroupingControl: View {
    let project: Project
    let server: String
    @AppStorage(FridayPreferenceKeys.projectGroupingOverrides) private var overrides = Data()
    private var selection: Binding<String> {
        Binding(get: { TaskProjectSidebar.dictionaries(overrides)[server]?[TaskProjectSidebar.normalize(project.path)] ?? "inherit" }, set: { value in
            var stored = TaskProjectSidebar.dictionaries(overrides), host = stored[server] ?? [:]
            host[TaskProjectSidebar.normalize(project.path)] = value == "inherit" ? nil : value
            stored[server] = host
            if let data = try? JSONEncoder().encode(stored) { overrides = data }
        })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker(selection: selection) {
                Text(friday: "使用全局项目分组").tag("inherit")
                ForEach(TaskProjectGrouping.allCases) { Text(fridayString: $0.title).tag($0.rawValue) }
            } label: { Text(friday: "项目分组") }.pickerStyle(.menu).fridayInteractiveCursor()
            Text(friday: "仅影响这台客户端的侧栏，不更改仓库或任务目录。").font(.caption).foregroundStyle(.secondary)
        }
    }
}
