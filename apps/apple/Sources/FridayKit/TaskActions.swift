import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

private struct TaskNewOnBranchKey: EnvironmentKey { static let defaultValue: ((WorkItem) -> Void)? = nil }
extension EnvironmentValues {
    var fridayNewTaskOnBranch: ((WorkItem) -> Void)? {
        get { self[TaskNewOnBranchKey.self] }
        set { self[TaskNewOnBranchKey.self] = newValue }
    }
}

extension View {
    func taskActions(store: FridayStore, task: WorkItem, opensMenu: Bool = false, onRename: (() -> Void)? = nil, sidebarMovement: TaskSidebarMovement? = nil, bulk: TaskBulkMenuContext? = nil, onRemoved: @escaping () -> Void = {}) -> some View {
        modifier(TaskActions(store: store, task: task, opensMenu: opensMenu, onRename: onRename, sidebarMovement: sidebarMovement, bulk: bulk, onRemoved: onRemoved))
    }
}

private struct TaskActions: ViewModifier {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let opensMenu: Bool
    let onRename: (() -> Void)?
    let sidebarMovement: TaskSidebarMovement?
    let bulk: TaskBulkMenuContext?
    let onRemoved: () -> Void
    @State private var renaming = false
    @State private var title = ""
    @State private var deleting = false
    @State private var customSnooze = false
    @State private var snoozeDate = Date().addingTimeInterval(3600)
    @State private var snoozeMode = "date"
    @State private var snoozeAmount = "2"
    @State private var snoozeUnit = "hours"
    @State private var busy = false
    @State private var failure: String?
    @State private var operation = UUID()
    @Environment(\.fridayNewTaskOnBranch) private var newTaskOnBranch
    @Environment(\.fridayTaskLifecycleNavigation) private var lifecycle
    @AppStorage("friday.tasks.confirmArchive") private var confirmArchive = false
    @State private var confirmingArchive = false

    func body(content: Content) -> some View {
        Group {
            if opensMenu {
                Menu { menu } label: { content }
                    #if os(macOS)
                    .menuStyle(.borderlessButton)
                    #endif
                    .fixedSize(horizontal: false, vertical: true)
                    .fridayInteractiveCursor()
            } else { content.contextMenu { menu } }
        }
        .alert(Text(friday: "重命名任务"), isPresented: $renaming) {
            TextField(friday: "任务名称", text: $title)
            Button(friday: "取消", role: .cancel) {}
            Button(friday: "保存") { change(["title": title]) }
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || title.utf16.count > 200)
        }
        .confirmationDialog(Text(friday: "删除任务？"), isPresented: $deleting, titleVisibility: .visible) {
            Button(friday: task.active || task.gitBusy || task.sessionBusy || task.backgroundStopAvailable ? "停止并删除任务" : "删除任务", role: .destructive) {
                let scope = store.connectionIdentity; let connection = store.connection; let token = UUID(); operation = token; busy = true
                Task { @MainActor in
                    defer { if operation == token { busy = false } }
                    guard scope == store.connectionIdentity, operation == token else { return }
                    do {
                        _ = try await connection.data("/api/tasks/\(task.id)", method: "DELETE")
                        guard scope == store.connectionIdentity, operation == token else { return }
                        await store.refresh()
                        if scope == store.connectionIdentity, operation == token { onRemoved() }
                    } catch { if scope == store.connectionIdentity, operation == token { failure = error.localizedDescription } }
                }
            }
            Button(friday: "取消", role: .cancel) {}
        } message: {
            Text(friday: "删除 Friday 中的对话和执行记录，保留项目文件与 Agent 原始会话。正在执行的任务会先停止。")
        }
        .confirmationDialog(Text(friday: "归档任务？"), isPresented: $confirmingArchive, titleVisibility: .visible) {
            Button(friday: "归档任务") { change(["archived": true], removesFromList: true) }
            Button(friday: "取消", role: .cancel) {}
        } message: { Text(verbatim: task.title) }
        .sheet(isPresented: $customSnooze) {
            VStack(alignment: .leading, spacing: 18) {
                Text(friday: "稍后处理").font(.headline)
                Picker(selection: $snoozeMode) {
                    Text(friday: "日期与时间").tag("date")
                    Text(friday: "时长").tag("duration")
                } label: { Text(friday: "稍后处理") }
                    .pickerStyle(.segmented).fridayInteractiveCursor()
                if snoozeMode == "date" {
                    DatePicker(selection: $snoozeDate, in: Date()..., displayedComponents: [.date, .hourAndMinute]) { Text(friday: "唤醒时间") }
                } else {
                    HStack {
                        TextField(friday: "时长", text: $snoozeAmount).textFieldStyle(.roundedBorder)
                        Picker(selection: $snoozeUnit) {
                            Text(friday: "分钟").tag("minutes")
                            Text(friday: "小时").tag("hours")
                            Text(friday: "天").tag("days")
                        } label: { Text(friday: "时长单位") }
                            .labelsHidden().fridayInteractiveCursor()
                    }
                }
                HStack {
                    Spacer()
                    Button(friday: "取消") { customSnooze = false }.buttonStyle(FridayButtonStyle())
                    Button(friday: "保存") {
                        let now = Date()
                        guard let date = snoozeMode == "date" ? (snoozeDate > now ? snoozeDate : nil) : TaskSnooze.duration(amount: snoozeAmount, unit: snoozeUnit, now: now) else { return }
                        customSnooze = false
                        change(["snoozedUntil": TaskSnooze.timestamp(date)])
                    }.buttonStyle(FridayButtonStyle(prominent: true))
                        .disabled(snoozeMode == "date" ? snoozeDate <= Date() : TaskSnooze.duration(amount: snoozeAmount, unit: snoozeUnit, now: .now) == nil)
                }
            }.padding(24).frame(minWidth: 320)
        }
        .alert(Text(friday: "任务操作失败"), isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button(friday: "好") { failure = nil }
        } message: { Text(failure ?? "") }
        .onChange(of: TaskActionUndo.context(store)) { _, _ in operation = UUID(); busy = false; failure = nil; renaming = false; deleting = false; customSnooze = false; confirmingArchive = false }
    }

    @ViewBuilder private var menu: some View {
        if let bulk { TaskBulkMenu(context: bulk) }
        else { actions }
    }

    @ViewBuilder private var actions: some View {
        Group {
            if let newTaskOnBranch, store.taskExistingWorkspaceSupported, task.subagentOrigin == nil, task.git?.branch != nil, store.projects.contains(where: { $0.id == task.projectId }) {
                Button(friday: "在此分支新建任务", systemImage: "square.and.pencil") { newTaskOnBranch(task) }
                Divider()
            }
            if task.archivedAt == nil {
                if task.settleCleanup?.status == "interrupted" {
                    Button(friday: "重新清理结束跟进的会话", systemImage: "arrow.clockwise") { change(["settled": true]) }.disabled(task.canSettle == false)
                    Divider()
                }
                if let sidebarMovement {
                    Button(friday: "上移", systemImage: "arrow.up") { sidebarMovement.up?() }.disabled(sidebarMovement.up == nil)
                    Button(friday: "下移", systemImage: "arrow.down") { sidebarMovement.down?() }.disabled(sidebarMovement.down == nil)
                    Divider()
                }
                Button(friday: task.pinnedAt == nil ? "置顶任务" : "取消置顶", systemImage: task.pinnedAt == nil ? "pin" : "pin.slash") {
                    change(["pinned": task.pinnedAt == nil])
                }
                Button(friday: TaskWorkspaces.shelf(task, now: .now) == .settled ? "移回活跃任务" : "结束跟进", systemImage: "checkmark.circle") {
                    change(["settled": TaskWorkspaces.shelf(task, now: .now) != .settled])
                }
                if TaskSnooze.isSnoozed(task, now: .now) {
                    Button(friday: "唤醒任务", systemImage: "clock") { change(["snoozedUntil": NSNull()]) }
                } else {
                    Menu {
                        ForEach(TaskSnooze.presets(now: .now)) { preset in
                            Button {
                                change(["snoozedUntil": TaskSnooze.timestamp(preset.until)])
                            } label: {
                                Text(fridayString: preset.label)
                                Text(preset.until, style: .time)
                            }
                        }
                        Button(friday: "自定义时间…") { snoozeDate = Date().addingTimeInterval(3600); snoozeMode = "date"; snoozeAmount = "2"; snoozeUnit = "hours"; customSnooze = true }
                    } label: { FridaySymbolLabel(friday: "稍后处理", systemImage: "clock") }
                        .disabled(!(task.canSnooze ?? !task.active) || task.gitBusy || task.sessionBusy)
                }
            }
            Divider()
            Button(friday: "重命名任务", systemImage: "pencil") {
                if let onRename { onRename() } else { title = task.title; renaming = true }
            }
            if task.titleGenerationSupported == true {
                Button(friday: task.titleRegeneration == nil ? "重新生成标题" : "正在重新生成标题", systemImage: "arrow.clockwise") { regenerateTitle() }
                    .disabled(task.titleRegeneration != nil)
            }
            Button(friday: "标为未读", systemImage: "envelope.badge") { change(["read": false]) }
            Menu {
                Button { change(["autoSettle": true]) } label: {
                    FridaySymbolLabel(friday: "启用", systemImage: task.autoSettle != false ? "checkmark" : "circle")
                }
                Button { change(["autoSettle": false]) } label: {
                    FridaySymbolLabel(friday: "停用", systemImage: task.autoSettle == false ? "checkmark" : "circle")
                }
            } label: { FridaySymbolLabel(friday: "自动结束跟进", systemImage: "timer") }
            Divider()
            Menu {
                Button(friday: "目录", systemImage: "folder") { copy(task.cwd) }
                if let branch = task.git?.branch {
                    Button(friday: "分支", systemImage: "arrow.triangle.branch") { copy(branch) }
                }
                Button(friday: "任务 ID", systemImage: "number") { copy(task.id) }
            } label: { FridaySymbolLabel(friday: "复制", systemImage: "doc.on.doc") }
            TaskOpenInControl(store: store, task: task, menuOnly: true)
            Divider()
            Button(friday: task.archivedAt == nil ? "归档任务" : "恢复任务", systemImage: "archivebox") {
                if task.archivedAt == nil && confirmArchive { confirmingArchive = true }
                else { change(["archived": task.archivedAt == nil], removesFromList: task.archivedAt == nil) }
            }.disabled(!TaskArchiveIndex.canArchive(task, lifecycleSupported: store.taskArchiveLifecycleSupported))
            Button(friday: "删除任务", systemImage: "trash", role: .destructive) { deleting = true }
        }.disabled(busy || !store.connected)
    }

    private func change(_ changes: [String: Any], removesFromList: Bool = false) {
        let scope = TaskActionUndo.context(store); let token = UUID(); operation = token; busy = true
        let restoreArchive: (() -> Void)? = changes["archived"] as? Bool == true && lifecycle?.selectedID == task.id ? { lifecycle?.open(task.id) } : nil
        Task { @MainActor in
            defer { if operation == token { busy = false } }
            guard scope == TaskActionUndo.context(store), operation == token else { return }
            do {
                try await store.taskUndo.perform(store: store, taskID: task.id, changes: changes, restored: restoreArchive)
                guard scope == TaskActionUndo.context(store), operation == token else { return }
                await store.refresh()
                if scope == TaskActionUndo.context(store), operation == token, removesFromList { lifecycle?.archived(task.id); onRemoved() }
            } catch { if scope == TaskActionUndo.context(store), operation == token { failure = error.localizedDescription } }
        }
    }


    private func regenerateTitle() {
        let scope = store.connectionIdentity; let connection = store.connection
        let token = UUID(); operation = token; busy = true
        Task { @MainActor in
            defer { if operation == token { busy = false } }
            guard scope == store.connectionIdentity, operation == token else { return }
            do {
                _ = try await connection.data("/api/tasks/\(task.id)/title/regenerate", method: "POST", body: ["requestId": UUID().uuidString])
                if scope == store.connectionIdentity, operation == token { await store.refresh() }
            } catch { if scope == store.connectionIdentity, operation == token { failure = error.localizedDescription } }
        }
    }

    private func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}
