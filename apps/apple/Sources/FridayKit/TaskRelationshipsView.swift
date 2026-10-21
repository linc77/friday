import SwiftUI

struct TaskRelationshipsControl: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let canNavigate: Bool
    let openTask: (String) -> Void
    @State private var showing = false
    @State private var visibleCount = 6
    @Environment(\.locale) private var locale
    private var rows: [TaskRelationships.Row] { TaskRelationships.rows(for: task, in: store.tasks) }
    private var agents: [TaskSubagent] { (task.subagents ?? []).filter { $0.parentSubagentId == task.subagentOrigin?.subagentId } }
    private var total: Int { rows.count + agents.count }

    var body: some View {
        if total > 0 {
            Button { showing.toggle() } label: {
                FridaySymbolImage(systemName: "arrow.triangle.branch").font(.system(size: 15)).frame(width: 24, height: 24)
            }.buttonStyle(FridaySymbolButtonStyle())
                .foregroundStyle(showing ? FridayTheme.accent : .secondary)
                .accessibilityLabel(Text(friday: "任务关系"))
                .accessibilityValue(Text(friday: "\(total) 个相关任务"))
                .help(Text(friday: "原任务、子 Agent 与分叉任务"))
                .popover(isPresented: $showing) { panel.environment(\.locale, locale) }
                .onChange(of: store.connectionIdentity) { _, _ in showing = false; visibleCount = 6 }
                .onChange(of: task.id) { _, _ in showing = false; visibleCount = 6 }
                .onDisappear { showing = false }
        }
    }
    private var panel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(friday: "任务关系").font(.headline)
                Spacer()
                Text("\(total)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            ScrollView {
                LazyVStack(spacing: 3) {
                    ForEach(Array(agents.prefix(visibleCount))) { agent in
                        TaskSubagentTimelineRow(store: store, agent: agent, allowsStop: true, openTask: { showing = false; openTask($0) })
                            .disabled(!canNavigate)
                    }
                    ForEach(Array(rows.prefix(TaskRelationships.visible(visibleCount, total: rows.count)))) { row in
                        Button {
                            showing = false; openTask(row.taskID)
                        } label: {
                            HStack(alignment: .center, spacing: 10) {
                                FridaySymbolImage(systemName: row.parent ? "arrow.turn.up.left" : "arrow.triangle.branch")
                                    .frame(width: 18).foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(verbatim: row.title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                                    HStack(spacing: 6) {
                                        Text(fridayString: row.parent ? "原任务" : "分叉任务")
                                        if let task = row.task {
                                            Text("·"); Text(fridayString: task.statusText)
                                            if task.archivedAt != nil { Text("·"); Text(friday: "已归档") }
                                        } else { Text("·"); Text(friday: "任务已删除或不可用") }
                                    }.font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 0)
                            }.padding(10).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }.buttonStyle(TaskRowButtonStyle(selected: false))
                            .disabled(row.task == nil || !canNavigate)
                            .help(Text(verbatim: row.task?.cwd ?? row.title))
                    }
                }
            }.scrollBounceBehavior(.basedOnSize)
                .frame(height: min(324, CGFloat(min(total, visibleCount * 2)) * 60))
            if max(rows.count, agents.count) > visibleCount {
                Button { visibleCount = TaskRelationships.showMore(visibleCount, total: max(rows.count, agents.count)) } label: {
                    HStack(spacing: 8) {
                        FridaySymbolImage(systemName: "plus")
                        Text(friday: "再显示 \(min(12, max(rows.count, agents.count) - visibleCount)) 项")
                        Spacer()
                    }.frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                }.buttonStyle(FridaySymbolButtonStyle())
            }
        }.padding(16).frame(width: 360)
    }
}
