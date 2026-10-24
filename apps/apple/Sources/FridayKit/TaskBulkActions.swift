import SwiftUI
import Combine

struct TaskBulkMenuContext {
    let selection: TaskBulkSelection
    let disabled: Bool
    let submit: (TaskBulkAction, Date?) -> Void
    let customSnooze: () -> Void
}

/// Selection survives project navigation, but belongs to exactly one account
/// and resident service. Menus freeze their targets before presenting a sheet.
@MainActor final class TaskBulkActions: ObservableObject {
    @Published var selection = TaskSidebarSelection()
    @Published var pendingDeletion: TaskBulkPlan?
    @Published var customSnooze: SnoozeSelection?
    @Published private(set) var busy = false
    let requests = TaskBulkCoordinator()
    var beforeExecute: (TaskBulkPlan) -> Void = { _ in }
    private var changes: AnyCancellable?
    private var operation = UUID()

    struct SnoozeSelection: Identifiable {
        let id = UUID()
        let tasks: [WorkItem]
        let context: String
    }
    init() {
        changes = requests.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }
    static func context(_ store: FridayStore) -> String {
        store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy")
    }
    func synchronize(_ store: FridayStore) {
        let context = Self.context(store)
        if selection.context != context {
            requests.reset(); operation = UUID(); busy = false; pendingDeletion = nil; customSnooze = nil
        }
        let available = store.snapshotIdentity == store.connectionIdentity
            ? Set(store.tasks.filter { $0.localAgent && $0.subagentOrigin == nil && $0.delegationOrigin == nil && $0.archivedAt == nil }.map(\.id)) : []
        selection.synchronize(context: context, available: available)
    }
    func retire() { requests.reset(); operation = UUID(); busy = false; pendingDeletion = nil; customSnooze = nil; selection.clear() }
    func menu(_ store: FridayStore, row: String? = nil) -> TaskBulkMenuContext? {
        guard row.map(selection.selected.contains) ?? true, selection.context == Self.context(store) else { return nil }
        let snapshot = TaskBulkSelection(tasks: store.tasks, selected: selection.selected, ordered: selection.ordered)
        guard snapshot.count > 0 else { return nil }
        let context = selection.context
        return TaskBulkMenuContext(selection: snapshot,
            disabled: busy || !store.connected || store.snapshotIdentity != store.connectionIdentity,
            submit: { [weak self] action, date in self?.choose(action, tasks: snapshot.targets(action), context: context, date: date, store: store) },
            customSnooze: { [weak self] in
                guard self?.busy == false, Self.context(store) == context, !snapshot.targets(.snooze).isEmpty else { return }
                self?.customSnooze = SnoozeSelection(tasks: snapshot.tasks, context: context)
            })
    }
    func choose(_ action: TaskBulkAction, tasks: [WorkItem], context: String, date: Date? = nil, store: FridayStore) {
        guard !busy, store.connected, Self.context(store) == context, !tasks.isEmpty else { return }
        let plan = TaskBulkPlan(action: action, tasks: tasks, context: context, snoozedUntil: date.map(TaskSnooze.timestamp))
        if action == .delete { pendingDeletion = plan }
        else { execute(plan, store: store) }
    }
    func execute(_ plan: TaskBulkPlan, store: FridayStore) {
        guard !busy, store.connected, Self.context(store) == plan.context else { return }
        let token = UUID(); operation = token; busy = true
        pendingDeletion = nil
        beforeExecute(plan)
        let connection = store.connection
        Task { @MainActor in
            defer { if operation == token { busy = false } }
            let result = await requests.run(plan, isCurrent: {
                Self.context(store) == plan.context && store.snapshotIdentity == store.connectionIdentity
            }, perform: { mutation in
                guard store.connected else { throw ConnectionError.message("主机未连接，请重新连接后重试") }
                if mutation.method == "PATCH", let body = mutation.body, let taskID = mutation.path.split(separator: "/").last {
                    var changes = body
                    if store.taskArchiveLifecycleSupported, let request = plan.requestID(for: String(taskID)) { changes["requestId"] = request }
                    try await store.taskUndo.perform(store: store, taskID: String(taskID), changes: changes)
                } else { _ = try await connection.data(mutation.path, method: mutation.method, body: mutation.body) }
            })
            guard result != nil, Self.context(store) == plan.context, requests.plan?.id == plan.id else { return }
            await store.refresh()
            guard Self.context(store) == plan.context, requests.plan?.id == plan.id else { return }
            if plan.action == .delete {
                requests.acknowledgeMissingDeletes(available: Set(store.tasks.map(\.id)))
                selection.remove(requests.outcome.succeeded)
            } else if plan.action != .regenerateTitle || requests.outcome.failures.isEmpty { selection.clear() }
        }
    }
}

struct TaskBulkMenu: View {
    let context: TaskBulkMenuContext
    private var selection: TaskBulkSelection { context.selection }
    var body: some View {
        Group {
            if !selection.pinned.isEmpty {
                Button { context.submit(.unpin, nil) } label: {
                    FridaySymbolLabel(friday: "取消置顶", systemImage: "pin.slash")
                    Text("(\(selection.pinned.count))")
                }
            }
            Button { context.submit(.settle, nil) } label: {
                FridaySymbolLabel(friday: "结束跟进", systemImage: "checkmark.circle")
                Text("(\(selection.count))")
            }.disabled(selection.settling.isEmpty)
            if selection.canSnooze {
                Menu {
                    ForEach(TaskSnooze.presets(now: .now)) { preset in
                        Button { context.submit(.snooze, preset.until) } label: {
                            Text(fridayString: preset.label)
                            Text(preset.until, style: .time)
                        }
                    }
                    Divider()
                    Button(friday: "自定义时间…", action: context.customSnooze)
                } label: {
                    FridaySymbolLabel(friday: "稍后处理", systemImage: "clock")
                    Text("(\(selection.count))")
                }
            }
            if !selection.titleSupported.isEmpty {
                Button { context.submit(.regenerateTitle, nil) } label: {
                    FridaySymbolLabel(friday: selection.regeneratable.isEmpty ? "正在重新生成标题" : "重新生成标题", systemImage: "arrow.clockwise")
                    Text("(\(selection.regeneratable.isEmpty ? selection.titleSupported.count : selection.regeneratable.count))")
                }.disabled(selection.regeneratable.isEmpty)
            }
            Button { context.submit(.markUnread, nil) } label: {
                FridaySymbolLabel(friday: "标为未读", systemImage: "envelope.badge")
                Text("(\(selection.count))")
            }
            Divider()
            Button(role: .destructive) { context.submit(.delete, nil) } label: {
                FridaySymbolLabel(friday: "删除任务", systemImage: "trash")
                Text("(\(selection.count))")
            }
        }.disabled(context.disabled)
    }
}

struct TaskBulkBar: View {
    @ObservedObject var store: FridayStore
    @ObservedObject var actions: TaskBulkActions
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let context = actions.menu(store) {
                HStack(spacing: 6) {
                    Text(friday: "已选择") + Text(" \(context.selection.count)")
                    Spacer(minLength: 0)
                    Menu { TaskBulkMenu(context: context) } label: {
                        FridaySymbolImage(systemName: "ellipsis").frame(width: 28, height: 28)
                    }
                    #if os(macOS)
                    .menuStyle(.borderlessButton)
                    #endif
                    .fixedSize().fridayInteractiveCursor()
                    .accessibilityLabel(Text(friday: "批量操作"))
                    .disabled(context.disabled)
                    Button { actions.selection.clear() } label: {
                        FridaySymbolImage(systemName: "xmark").frame(width: 28, height: 28)
                    }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "取消选择"))
                        .accessibilityLabel(Text(friday: "取消选择"))
                        .disabled(actions.busy)
                }
            }
            if let plan = actions.requests.plan {
                let requests = actions.requests
                if actions.busy {
                    Text(friday: "正在批量处理") + Text(" \(requests.processed)/\(plan.taskIDs.count)")
                } else if !requests.outcome.failures.isEmpty {
                    HStack(alignment: .top, spacing: 6) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(friday: "部分任务未完成")
                            Text("\(requests.outcome.succeeded.count)/\(plan.taskIDs.count)").monospacedDigit()
                            if let first = plan.taskIDs.compactMap({ requests.outcome.failures[$0] }).first {
                                Text(first).lineLimit(3).textSelection(.enabled)
                            }
                        }.foregroundStyle(.orange)
                        Spacer(minLength: 0)
                        Button(friday: "重试") { actions.execute(plan, store: store) }
                            .buttonStyle(FridayButtonStyle()).disabled(!store.connected)
                        Button { requests.reset() } label: {
                            FridaySymbolImage(systemName: "xmark").frame(width: 24, height: 24)
                        }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "关闭"))
                    }
                }
            }
        }.font(.caption).padding(.horizontal, 12)
            .padding(.bottom, actions.selection.hasSelection || actions.busy || !actions.requests.outcome.failures.isEmpty ? 8 : 0)
    }
}

extension View {
    func taskBulkPresentation(store: FridayStore, actions: TaskBulkActions, beforeExecute: @escaping (TaskBulkPlan) -> Void = { _ in }) -> some View {
        modifier(TaskBulkPresentation(store: store, actions: actions, beforeExecute: beforeExecute))
    }
}

private struct TaskBulkPresentation: ViewModifier {
    @ObservedObject var store: FridayStore
    @ObservedObject var actions: TaskBulkActions
    let beforeExecute: (TaskBulkPlan) -> Void
    func body(content: Content) -> some View {
        content
            .onAppear { actions.synchronize(store); actions.beforeExecute = beforeExecute }
            .onChange(of: TaskBulkActions.context(store)) { _, _ in actions.synchronize(store) }
            .onChange(of: store.snapshotIdentity) { _, _ in actions.synchronize(store) }
            .onChange(of: store.tasks.map { $0.id + ($0.archivedAt ?? "") }) { _, _ in actions.synchronize(store) }
            .onDisappear { actions.retire() }
            .confirmationDialog(Text(friday: "删除所选任务？"), isPresented: Binding(get: { actions.pendingDeletion != nil }, set: { if !$0 { actions.pendingDeletion = nil } }), titleVisibility: .visible) {
                if let plan = actions.pendingDeletion {
                    Button(role: .destructive) { actions.execute(plan, store: store) } label: {
                        Text(friday: "删除任务") + Text(" (\(plan.taskIDs.count))")
                    }
                }
                Button(friday: "取消", role: .cancel) { actions.pendingDeletion = nil }
            } message: {
                Text(friday: "删除 Friday 中的对话和执行记录，保留项目文件与 Agent 原始会话。正在执行的任务会先停止。")
                if let plan = actions.pendingDeletion {
                    Text("\(plan.taskIDs.count) ") + Text(friday: "个任务")
                }
            }
            .sheet(item: $actions.customSnooze) { target in
                TaskBulkSnoozeSheet { date in
                    actions.customSnooze = nil
                    if let date { actions.choose(.snooze, tasks: target.tasks, context: target.context, date: date, store: store) }
                }
            }
    }
}

private struct TaskBulkSnoozeSheet: View {
    let complete: (Date?) -> Void
    @State private var date = Date().addingTimeInterval(3600)
    @State private var mode = "date"
    @State private var amount = "2"
    @State private var unit = "hours"
    private var target: Date? { mode == "date" ? (date > Date() ? date : nil) : TaskSnooze.duration(amount: amount, unit: unit, now: .now) }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(friday: "稍后处理").font(.headline)
            Picker(selection: $mode) {
                Text(friday: "日期与时间").tag("date")
                Text(friday: "时长").tag("duration")
            } label: { Text(friday: "稍后处理") }.pickerStyle(.segmented).fridayInteractiveCursor()
            if mode == "date" {
                DatePicker(selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute]) { Text(friday: "唤醒时间") }
            } else {
                HStack {
                    TextField(friday: "时长", text: $amount).textFieldStyle(.roundedBorder)
                    Picker(selection: $unit) {
                        Text(friday: "分钟").tag("minutes")
                        Text(friday: "小时").tag("hours")
                        Text(friday: "天").tag("days")
                    } label: { Text(friday: "时长单位") }.labelsHidden().fridayInteractiveCursor()
                }
            }
            HStack {
                Spacer()
                Button(friday: "取消") { complete(nil) }.buttonStyle(FridayButtonStyle())
                Button(friday: "保存") { if let target { complete(target) } }
                    .buttonStyle(FridayButtonStyle(prominent: true)).disabled(target == nil)
            }
        }.padding(24).frame(minWidth: 320)
    }
}
