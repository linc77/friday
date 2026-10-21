import SwiftUI
#if os(macOS)
import AppKit
import WebKit
#endif

struct TaskLifecycleNavigation {
    let selectedID: String?
    let archived: (String) -> Void
    let open: (String) -> Void
}
private struct TaskLifecycleNavigationKey: EnvironmentKey { static let defaultValue: TaskLifecycleNavigation? = nil }
extension EnvironmentValues {
    var fridayTaskLifecycleNavigation: TaskLifecycleNavigation? {
        get { self[TaskLifecycleNavigationKey.self] }
        set { self[TaskLifecycleNavigationKey.self] = newValue }
    }
}

@MainActor final class TaskActionUndo: ObservableObject {
    private struct MetadataAck: Decodable { let ok: Bool; var applied: Bool? = nil }
    @Published private(set) var ledger = TaskUndoLedger()
    @Published var failures: [String] = []
    private var callbacks: [UUID: () -> Void] = [:]
    private typealias LocalRestore = @MainActor () throws -> Void
    private var localRestores: [UUID: LocalRestore] = [:]
    private var expiry: Task<Void, Never>?
    static func context(_ store: FridayStore) -> String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy") }
    func synchronize(_ store: FridayStore) {
        let scope = Self.context(store)
        if ledger.context != scope { expiry?.cancel(); callbacks = [:]; localRestores = [:]; failures = [] }
        ledger.synchronize(context: scope)
        if store.snapshotIdentity == store.connectionIdentity { ledger.removeMissing(Set(store.tasks.map(\.id))) }
        pruneCallbacks()
    }
    private func pruneCallbacks() { let ids = Set(ledger.records.map(\.id)); callbacks = callbacks.filter { ids.contains($0.key) }; localRestores = localRestores.filter { ids.contains($0.key) } }
    func discardedDraft(store: FridayStore, key: String, restore: @escaping @MainActor () throws -> Void) {
        synchronize(store)
        let claim = ledger.begin(.discard, taskID: key)
        if let id = ledger.record(claim, restore: .init(taskID: key, kind: .discard), now: .now) { localRestores[id] = restore; pruneCallbacks(); scheduleExpiry() }
    }
    func invalidatePin(taskID: String) { ledger.invalidate(.pin, taskID: taskID); pruneCallbacks() }
    func perform(store: FridayStore, taskID: String, changes: [String: Any], restored: (() -> Void)? = nil, path: String? = nil, method: String = "PATCH", payload: [String: Any]? = nil) async throws {
        synchronize(store)
        guard store.connected, store.snapshotIdentity == store.connectionIdentity, let task = store.tasks.first(where: { $0.id == taskID }) else { throw ConnectionError.message("任务执行范围已经改变") }
        let scope = ledger.context, connection = store.connection
        var body = payload ?? changes
        if store.taskArchiveLifecycleSupported, body["requestId"] == nil { body["requestId"] = UUID().uuidString }
        var claim: TaskUndoLedger.Claim?, restore: TaskUndoRestore?
        if let archived = changes["archived"] as? Bool {
            if archived { claim = ledger.begin(.archive, taskID: taskID); restore = .init(taskID: taskID, kind: .archive) }
            else { ledger.invalidate(.archive, taskID: taskID) }
        } else if let pinned = changes["pinned"] as? Bool {
            if !pinned { claim = ledger.begin(.pin, taskID: taskID); restore = .init(taskID: taskID, kind: .pin, pinOrderKey: store.taskArchiveLifecycleSupported ? task.pinOrderKey : nil) }
            else { ledger.invalidate(.pin, taskID: taskID) }
        } else if let settled = changes["settled"] as? Bool {
            if settled {
                ledger.invalidate(.pin, taskID: taskID); ledger.invalidate(.snooze, taskID: taskID)
                claim = ledger.begin(.settle, taskID: taskID)
                restore = .init(taskID: taskID, kind: .settle, wasPinned: task.pinnedAt != nil, pinOrderKey: store.taskArchiveLifecycleSupported ? task.pinOrderKey : nil, snoozedUntil: task.snoozedUntil)
            } else { ledger.invalidate(.settle, taskID: taskID) }
        } else if changes["snoozedUntil"] != nil {
            if changes["snoozedUntil"] is String { claim = ledger.begin(.snooze, taskID: taskID); restore = .init(taskID: taskID, kind: .snooze) }
            else { ledger.invalidate(.snooze, taskID: taskID) }
        }
        pruneCallbacks()
        do {
            let result = try await connection.decode(MetadataAck.self, path ?? "/api/tasks/\(taskID)", method: method, body: body)
            guard Self.context(store) == scope else { return }
            if result.applied == false { if let claim { ledger.finish(claim); pruneCallbacks() }; return }
            if let claim, let restore, let id = ledger.record(claim, restore: restore, now: .now) {
                if let restored { callbacks[id] = restored }; scheduleExpiry()
            }
        } catch {
            if Self.context(store) == scope, let claim { ledger.finish(claim); pruneCallbacks() }
            throw error
        }
    }
    @discardableResult func undo(store: FridayStore) -> Bool {
        synchronize(store)
        guard let notice = ledger.notice, notice.kind == .discard || store.connected && store.snapshotIdentity == store.connectionIdentity else { return false }
        let scope = ledger.context, connection = store.connection
        let group = ledger.consume(notice, now: .now)
        let savedCallbacks = callbacks, savedLocal = localRestores; pruneCallbacks()
        guard !group.isEmpty else { return false }
        Task { @MainActor in
            // Like T3's grouped Undo, each accepted action is restored once.
            // Captured claims are consumed before the first asynchronous wait.
            await withTaskGroup(of: Void.self) { jobs in
                for record in group {
                    jobs.addTask { @MainActor in
                        guard Self.context(store) == scope else { return }
                        do {
                            if record.restore.kind == .discard { if let restore = savedLocal[record.id] { try restore() }; return }
                            guard store.connected else { return }
                            var body = record.restore.body
                            if store.taskArchiveLifecycleSupported { body["requestId"] = "undo-" + record.id.uuidString }
                            _ = try await connection.data("/api/tasks/\(record.restore.taskID)", method: "PATCH", body: body)
                            guard Self.context(store) == scope else { return }
                            savedCallbacks[record.id]?()
                        } catch { if Self.context(store) == scope { self.failures.append(error.localizedDescription) } }
                    }
                }
            }
            if Self.context(store) == scope, group.contains(where: { $0.restore.kind != .discard }) { await store.refresh() }
        }
        return true
    }
    private func scheduleExpiry() {
        expiry?.cancel()
        let deadline = ledger.expiresAt
        expiry = Task { @MainActor [weak self] in
            guard let deadline else { return }
            do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) } catch { return }
            guard let self, self.ledger.expiresAt == deadline else { return }
            self.ledger.expire(now: .now); self.pruneCallbacks()
        }
    }
}

struct TaskUndoNotice: View {
    @ObservedObject var store: FridayStore
    @ObservedObject var state: TaskActionUndo
    var body: some View {
        if state.ledger.context == TaskActionUndo.context(store), let notice = state.ledger.notice {
            HStack(spacing: 6) {
                Text(fridayString: notice.kind.label) + Text(" \(notice.count)")
                Spacer(minLength: 2)
                Button(friday: "撤销") { state.undo(store: store) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected && notice.kind != .discard)
                    #if os(macOS)
                    .help(Text(friday: "⌘ Z 撤销任务操作；文字编辑保留原生撤销"))
                    #endif
            }.font(.caption).padding(10).background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
        }
        if state.ledger.context == TaskActionUndo.context(store), !state.failures.isEmpty {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(state.failures.prefix(3).enumerated()), id: \.offset) { entry in Text(fridayString: entry.element).font(.caption).foregroundStyle(.orange).lineLimit(3) }
                }
                Spacer(minLength: 2)
                Button { state.failures = [] } label: { FridaySymbolImage(systemName: "xmark").frame(width: 24, height: 24) }
                    .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "关闭"))
            }.padding(10)
        }
    }
}

#if os(macOS)
/// Local keyboard routing only. Native text input and terminal/browser focus
/// retain their responder-chain Undo; no window/AX inspection is performed.
struct TaskUndoKeyboard: NSViewRepresentable {
    let undo: () -> Bool
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSView {
        let view = NSView(); let coordinator = context.coordinator; coordinator.undo = undo
        coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak view, weak coordinator] event in
            guard let view, let window = view.window, window === NSApp.keyWindow,
                  event.modifierFlags.intersection([.command, .control, .option, .shift]) == .command,
                  event.charactersIgnoringModifiers?.lowercased() == "z" else { return event }
            let responder = window.firstResponder
            if responder is NSTextInputClient { return event }
            var ancestor = responder as? NSView
            while let current = ancestor {
                if current is WKWebView || NSStringFromClass(type(of: current)).contains("Terminal") { return event }
                ancestor = current.superview
            }
            return coordinator?.undo?() == true ? nil : event
        }
        return view
    }
    func updateNSView(_ view: NSView, context: Context) { context.coordinator.undo = undo }
    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { if let monitor = coordinator.monitor { NSEvent.removeMonitor(monitor) } }
    final class Coordinator { var monitor: Any?; var undo: (() -> Bool)? }
}
#endif
