import SwiftUI

struct TaskBehaviorSettingsView: View {
    @Bindable var store: FridayStore
    @FridayPreference("friday.tasks.confirmArchive") private var confirmArchive = false

    var body: some View {
        SettingsPage(title: "任务设置", subtitle: "管理任务归档确认和自动结束跟进规则。") {
            SettingsGroup("任务操作") {
                SettingsRow("归档前确认", detail: "归档后可从已归档任务中恢复。") {
                    Toggle(isOn: $confirmArchive) { Text(friday: "归档前确认") }.labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
                }
            }
            if store.taskAutoSettlementSupported { TaskSettlementSettingsView(store: store) }
        }
    }
}
