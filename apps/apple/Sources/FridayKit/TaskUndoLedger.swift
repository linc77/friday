/*
Adapted from T3 Code 8cd9641f hooks/threadUndo.ts and showThreadUndoNotice.ts.
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

enum TaskUndoKind: String, Hashable {
    case archive, pin, settle, snooze, discard
    var label: String { switch self { case .archive: "已归档"; case .pin: "已取消置顶"; case .settle: "已结束跟进"; case .snooze: "已稍后处理"; case .discard: "已丢弃草稿" } }
}

enum TaskArchiveIndex {
    struct Group: Identifiable { let id: String; let project: Project?; let title: String; let tasks: [WorkItem] }
    static func canArchive(_ task: WorkItem, lifecycleSupported: Bool) -> Bool {
        guard task.subagentOrigin == nil && task.delegationOrigin == nil else { return false }
        if task.archivedAt != nil { return true }
        guard !task.gitBusy, !task.sessionBusy, task.branchChange?.active != true else { return false }
        if !lifecycleSupported { return !task.active && task.queue?.pending.isEmpty != false }
        if task.status == "running" { return false }
        if task.status == "queued" { return task.currentRunId == nil }
        return true
    }
    static func groups(tasks: [WorkItem], projects: [Project], scope: String?) -> [Group] {
        let archived = tasks.filter { $0.localAgent && $0.subagentOrigin == nil && $0.delegationOrigin == nil && $0.archivedAt != nil && (scope == nil || $0.projectId == scope) }
        var keys = projects.map(\.id), grouped: [String: [WorkItem]] = [:]
        for task in archived {
            let key = task.projectId ?? "unregistered:" + task.cwd
            if !keys.contains(key) { keys.append(key) }; grouped[key, default: []].append(task)
        }
        return keys.compactMap { key in
            guard let members = grouped[key], !members.isEmpty else { return nil }
            let project = projects.first { $0.id == key }
            let sorted = members.sorted {
                let left = $0.archivedAt ?? $0.createdAt, right = $1.archivedAt ?? $1.createdAt
                return left == right ? $0.id > $1.id : left > right
            }
            return Group(id: key, project: project, title: project?.name ?? URL(fileURLWithPath: members[0].cwd).lastPathComponent, tasks: sorted)
        }
    }
}
struct TaskUndoRestore {
    let taskID: String
    let kind: TaskUndoKind
    var wasPinned = false
    var pinOrderKey: String? = nil
    var snoozedUntil: String? = nil
    var body: [String: Any] {
        switch kind {
        case .archive: return ["archived": false]
        case .pin:
            var body: [String: Any] = ["pinned": true]
            if let pinOrderKey { body["pinOrderKey"] = pinOrderKey }; return body
        case .settle:
            var body: [String: Any] = ["settled": false]
            if wasPinned { body["pinned"] = true; if let pinOrderKey { body["pinOrderKey"] = pinOrderKey } }
            if let snoozedUntil { body["snoozedUntil"] = snoozedUntil }; return body
        case .snooze: return ["snoozedUntil": NSNull()]
        case .discard: return [:]
        }
    }
}


/// Five-second, client-only claims shared by every task action entry point.
/// Claims are consumed synchronously before any restore request is awaited.
struct TaskUndoLedger {
    struct Key: Hashable { let kind: TaskUndoKind; let taskID: String }
    struct Claim: Equatable { let context: String; let key: Key; let token: UUID }
    struct Record: Identifiable { let id = UUID(); let claim: Claim; let restore: TaskUndoRestore }
    struct Notice: Equatable { let kind: TaskUndoKind; let count: Int; let ids: [UUID] }
    private(set) var context = ""
    private var current: [Key: UUID] = [:]
    private(set) var records: [Record] = []
    private(set) var expiresAt: Date?
    mutating func synchronize(context: String) {
        guard self.context != context else { return }; self = Self(); self.context = context
    }
    mutating func begin(_ kind: TaskUndoKind, taskID: String) -> Claim {
        let claim = Claim(context: context, key: .init(kind: kind, taskID: taskID), token: UUID())
        current[claim.key] = claim.token; prune(); return claim
    }
    func isCurrent(_ claim: Claim) -> Bool { claim.context == context && current[claim.key] == claim.token }
    mutating func invalidate(_ kind: TaskUndoKind, taskID: String) { current.removeValue(forKey: .init(kind: kind, taskID: taskID)); prune() }
    mutating func removeMissing(_ ids: Set<String>) {
        current = current.filter { $0.key.kind == .discard || ids.contains($0.key.taskID) }; prune()
    }
    mutating func finish(_ claim: Claim) { if isCurrent(claim) { current.removeValue(forKey: claim.key) }; prune() }
    mutating func record(_ claim: Claim, restore: TaskUndoRestore, now: Date) -> UUID? {
        guard isCurrent(claim) else { return nil }
        let entry = Record(claim: claim, restore: restore); records.append(entry); expiresAt = now.addingTimeInterval(5); return entry.id
    }
    var notice: Notice? {
        let current = records.filter { isCurrent($0.claim) }; guard let last = current.last else { return nil }
        let group = current.reversed().prefix { $0.restore.kind == last.restore.kind }
        return Notice(kind: last.restore.kind, count: group.count, ids: group.map(\.id))
    }
    mutating func consume(_ notice: Notice, now: Date) -> [Record] {
        expire(now: now)
        let ids = Set(notice.ids), group = records.reversed().filter { ids.contains($0.id) && isCurrent($0.claim) }
        records.removeAll { ids.contains($0.id) }
        for entry in group where isCurrent(entry.claim) { current.removeValue(forKey: entry.claim.key) }
        prune(); return group
    }
    mutating func expire(now: Date) {
        guard let expiresAt, now >= expiresAt else { return }
        let expired = records; records = []; self.expiresAt = nil
        for entry in expired where isCurrent(entry.claim) { current.removeValue(forKey: entry.claim.key) }
    }
    private mutating func prune() { records = records.filter { isCurrent($0.claim) }; if records.isEmpty { expiresAt = nil } }
}
