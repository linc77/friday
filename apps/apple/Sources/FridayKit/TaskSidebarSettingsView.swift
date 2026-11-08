import SwiftUI

struct TaskSidebarSettingsView: View {
    @Bindable var store: FridayStore

    var body: some View {
        SettingsPage(title: "任务侧栏", subtitle: "调整项目分组、任务排序和侧栏列表。") {
            SettingsGroup("任务侧栏") {
                TaskSidebarSettingsRows()
                SettingsDivider()
                SettingsRow("Working 分组（Beta）", detail: "折叠正在处理的任务；需要你处理时回到活跃列表顶部，活跃列表按返回时间排序。") {
                    Toggle(isOn: $store.sidebarWorkingShelfEnabled) { Text(friday: "Working 分组（Beta）") }
                        .labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
                }
                if store.sidebarWorkingShelfEnabled {
                    SettingsDivider()
                    SettingsRow("恢复默认", detail: "关闭 Working 分组并恢复已保存的手动排序。") {
                        Button(friday: "恢复默认") { store.sidebarWorkingShelfEnabled = false }.buttonStyle(FridayButtonStyle(compact: true))
                    }
                }
            }
        }
    }
}

struct TaskSidebarSettingsRows: View {
    @FridayPreference(FridayPreferenceKeys.legacySidebar) private var legacySidebar = false
    @FridayPreference(FridayPreferenceKeys.projectGrouping) private var grouping: TaskProjectGrouping = .repository
    @FridayPreference(FridayPreferenceKeys.projectSort) private var projectSort: TaskProjectSort = .updated
    @FridayPreference(FridayPreferenceKeys.threadSort) private var threadSort: TaskThreadSort = .updated
    @FridayPreference(FridayPreferenceKeys.threadPreviewCount) private var count = 6
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
    @FridayPreference(FridayPreferenceKeys.projectGroupingOverrides) private var overrides = Data()
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
