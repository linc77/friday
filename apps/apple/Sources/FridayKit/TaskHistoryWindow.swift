import Foundation

struct TaskHistoryRange: Equatable {
    let lower: Int; let upper: Int
    var limit: Int { min(128, max(0, upper - lower)) }
}

// Retain expanded history independently from the live tail. Projection epochs
// prevent a late page from resurrecting entries removed by rewind or fork.
struct TaskHistoryWindow {
    private(set) var scope = ""
    private(set) var epoch = ""
    private(set) var count = 0
    private var version = 0
    private var liveBaseline = 0
    private var events: [String: TaskEvent] = [:]
    private var fallbackOrder: [String: Int] = [:]
    private var positions: [String: Int] = [:]
    private var covered: [TaskHistoryRange] = []
    private var stale: Set<Int> = []

    var hasEarlier: Bool { nextEarlier != nil }
    var nextEarlier: TaskHistoryRange? { missing(lower: 0, upper: count) }
    func contains(_ id: String, live task: WorkItem, scope: String) -> Bool {
        task.events.contains { $0.id == id } || (self.scope == scope && epoch == task.history?.epoch && events[id] != nil)
    }
    var nextAutomatic: TaskHistoryRange? {
        if let position = stale.max() { return TaskHistoryRange(lower: max(0, position - 127), upper: position + 1) }
        return missing(lower: liveBaseline, upper: count)
    }
    mutating func accept(_ task: WorkItem, scope: String) {
        guard let info = task.history else { return }
        if self.scope != scope || epoch != info.epoch {
            self = TaskHistoryWindow(); self.scope = scope; epoch = info.epoch; liveBaseline = info.count
        }
        if version > 0, info.version - version > info.recent.count, info.version - version > max(0, info.count - count) {
            stale.formUnion(positions.filter { events[$0.key] != nil }.map(\.value)); covered = []
        }
        count = info.count; version = info.version
        for event in task.events {
            if fallbackOrder[event.id] == nil { fallbackOrder[event.id] = fallbackOrder.count }
            events[event.id] = event
        }
        for recent in info.recent where recent.position >= 0 && recent.position < count {
            positions[recent.id] = recent.position
            if events[recent.id]?.historyDigest == recent.digest {
                cover(recent.position, recent.position + 1); stale.remove(recent.position)
            } else if events[recent.id] != nil {
                uncover(recent.position); stale.insert(recent.position)
            }
        }
    }
    @discardableResult mutating func apply(_ page: TaskHistoryPage, live task: WorkItem, scope: String) -> Bool {
        guard self.scope == scope, self.epoch == page.epoch, let info = task.history, page.taskId == task.id, page.epoch == info.epoch,
              page.from >= 0, page.to >= page.from, page.to <= info.count, page.events.count == page.to - page.from else { return false }
        accept(task, scope: scope)
        guard self.scope == scope, epoch == page.epoch else { return false }
        let expected = info.recent.reduce(into: [String: String]()) { $0[$1.id] = $1.digest }
        for (offset, event) in page.events.enumerated() {
            positions[event.id] = page.from + offset
            if let digest = expected[event.id], events[event.id]?.historyDigest == digest, event.historyDigest != digest { continue }
            events[event.id] = event
        }
        cover(page.from, page.to); stale.subtract(page.from..<page.to)
        // A newer live tail always wins over the page that was in flight.
        accept(task, scope: scope)
        return true
    }
    func presenting(_ task: WorkItem, scope: String) -> WorkItem {
        guard self.scope == scope, task.history?.epoch == epoch else { return task }
        var result = task; var merged = events
        for event in task.events { merged[event.id] = event }
        result.events = merged.values.sorted { a, b in
            if a.historyOrder != b.historyOrder { return (a.historyOrder ?? Int.max) < (b.historyOrder ?? Int.max) }
            if a.historyOrder == nil, fallbackOrder[a.id] != fallbackOrder[b.id] { return (fallbackOrder[a.id] ?? Int.max) < (fallbackOrder[b.id] ?? Int.max) }
            return a.at == b.at ? a.id < b.id : a.at < b.at
        }
        return result
    }
    private func missing(lower: Int, upper: Int) -> TaskHistoryRange? {
        guard upper > lower else { return nil }
        var end = upper
        for range in covered.reversed() {
            if range.lower >= end { continue }
            if range.upper < end { return TaskHistoryRange(lower: max(lower, range.upper), upper: end) }
            end = max(lower, range.lower)
            if end <= lower { return nil }
        }
        return end > lower ? TaskHistoryRange(lower: lower, upper: end) : nil
    }
    private mutating func cover(_ lower: Int, _ upper: Int) {
        guard upper > lower else { return }
        let ranges = (covered + [TaskHistoryRange(lower: lower, upper: upper)]).sorted { $0.lower < $1.lower }
        var result: [TaskHistoryRange] = []
        for range in ranges {
            if let last = result.last, range.lower <= last.upper {
                result[result.count - 1] = TaskHistoryRange(lower: last.lower, upper: max(last.upper, range.upper))
            } else { result.append(range) }
        }
        covered = result
    }
    private mutating func uncover(_ position: Int) {
        covered = covered.flatMap { range -> [TaskHistoryRange] in
            guard position >= range.lower && position < range.upper else { return [range] }
            return [TaskHistoryRange(lower: range.lower, upper: position), TaskHistoryRange(lower: position + 1, upper: range.upper)].filter { $0.upper > $0.lower }
        }
    }
}
