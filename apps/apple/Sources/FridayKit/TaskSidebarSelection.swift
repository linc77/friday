/*
Adapted from T3 Code 8cd9641f apps/web/src/threadSelectionStore.ts / components/Sidebar.tsx.
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import Foundation

/// Bulk selection is separate from the conversation currently being viewed.
/// Modifier clicks never navigate or acknowledge unread content.
struct TaskSidebarSelection {
    private(set) var selected: Set<String> = []
    private(set) var ordered: [String] = []
    private(set) var anchor: String?
    private(set) var context = ""
    var hasSelection: Bool { !selected.isEmpty }

    mutating func synchronize(context: String, available: Set<String>) {
        if self.context != context { self = Self(); self.context = context }
        selected.formIntersection(available)
        ordered.removeAll { !selected.contains($0) }
        if let anchor, !available.contains(anchor) { self.anchor = nil }
    }
    mutating func toggle(_ id: String) {
        if selected.remove(id) == nil { selected.insert(id); ordered.append(id); anchor = id }
        else { ordered.removeAll { $0 == id } }
    }
    mutating func range(to id: String, ordered: [String]) {
        guard let anchor, let from = ordered.firstIndex(of: anchor), let to = ordered.firstIndex(of: id) else {
            if selected.insert(id).inserted { self.ordered.append(id) }; anchor = id; return
        }
        for key in ordered[min(from, to)...max(from, to)] {
            if selected.insert(key).inserted { self.ordered.append(key) }
        }
    }
    mutating func activate(_ id: String) { selected = []; ordered = []; anchor = id }
    mutating func clear() { selected = []; ordered = []; anchor = nil }
    mutating func remove(_ ids: Set<String>) {
        selected.subtract(ids)
        ordered.removeAll { ids.contains($0) }
        if let anchor, ids.contains(anchor) { self.anchor = nil }
    }
}

enum TaskBulkAction: String, CaseIterable { case unpin, settle, snooze, regenerateTitle, markUnread, delete }

struct TaskBulkSelection {
    let tasks: [WorkItem]
    var count: Int { tasks.count }
    var pinned: [WorkItem] { tasks.filter { $0.pinnedAt != nil } }
    var settling: [WorkItem] { tasks.filter { $0.settledOverride != "settled" } }
    var titleSupported: [WorkItem] { tasks.filter { $0.titleGenerationSupported == true } }
    var regeneratable: [WorkItem] { titleSupported.filter { $0.titleRegeneration == nil } }
    var canSnooze: Bool {
        !tasks.isEmpty && tasks.allSatisfy { ($0.canSnooze ?? !$0.active) && !$0.gitBusy && !$0.sessionBusy }
    }
    func targets(_ action: TaskBulkAction) -> [WorkItem] {
        switch action {
        case .unpin: pinned
        case .settle: settling
        case .regenerateTitle: regeneratable
        case .snooze: canSnooze ? tasks : []
        case .markUnread, .delete: tasks
        }
    }
    init(tasks: [WorkItem], selected: Set<String>, ordered: [String]? = nil) {
        let eligible = tasks.filter { selected.contains($0.id) && $0.localAgent && $0.subagentOrigin == nil && $0.archivedAt == nil }
        if let ordered {
            let byID = Dictionary(uniqueKeysWithValues: eligible.map { ($0.id, $0) })
            self.tasks = ordered.compactMap { byID[$0] }
        } else { self.tasks = eligible }
    }
}

struct TaskBulkMutation {
    let path: String; let method: String; let body: [String: Any]?
}

/// The menu freezes target IDs and title request receipts before any mutation.
/// Retrying a transport failure reuses the same model-generation request.
struct TaskBulkPlan: Identifiable {
    let id = UUID()
    let action: TaskBulkAction
    let taskIDs: [String]
    let context: String
    let snoozedUntil: String?
    private let requestIDs: [String: String]
    init(action: TaskBulkAction, tasks: [WorkItem], context: String, snoozedUntil: String? = nil) {
        self.action = action; self.taskIDs = tasks.map(\.id); self.context = context; self.snoozedUntil = snoozedUntil
        self.requestIDs = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, UUID().uuidString) })
    }
    func request(for id: String) -> TaskBulkMutation? {
        guard taskIDs.contains(id) else { return nil }
        let path = "/api/tasks/\(id)"
        switch action {
        case .unpin: return TaskBulkMutation(path: path, method: "PATCH", body: ["pinned": false])
        case .settle: return TaskBulkMutation(path: path, method: "PATCH", body: ["settled": true])
        case .markUnread: return TaskBulkMutation(path: path, method: "PATCH", body: ["read": false])
        case .snooze:
            guard let snoozedUntil else { return nil }
            return TaskBulkMutation(path: path, method: "PATCH", body: ["snoozedUntil": snoozedUntil])
        case .regenerateTitle:
            guard let requestID = requestIDs[id] else { return nil }
            return TaskBulkMutation(path: path + "/title/regenerate", method: "POST", body: ["requestId": requestID])
        case .delete: return TaskBulkMutation(path: path, method: "DELETE", body: nil)
        }
    }
    func requestID(for id: String) -> String? { requestIDs[id] }
}
