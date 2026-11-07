import Foundation

@main struct TaskSnoozeTests {
    static func date(_ value: String) -> Date { CodexTranscript.date(value)! }
    static func calendar(_ zone: String = "Asia/Shanghai") -> Calendar {
        var value = Calendar(identifier: .gregorian); value.timeZone = TimeZone(identifier: zone)!; return value
    }
    static func task(_ overrides: [String: Any] = [:]) throws -> WorkItem {
        var body: [String: Any] = ["id": "task", "title": "Task", "agent": "codex", "mode": "research", "cwd": "/owned-fixture", "prompt": "", "result": "", "events": [], "approvals": [],
            "status": "completed", "createdAt": "2026-10-18T01:00:00Z", "updatedAt": "2026-10-18T02:00:00Z"]
        body.merge(overrides) { _, new in new }
        return try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: body))
    }
    static func main() throws {
        let zone = calendar()
        let friday = date("2026-10-16T16:59:59+08:00")
        let presets = TaskSnooze.presets(now: friday, calendar: zone)
        precondition(presets.map(\.id) == ["hour", "three-hours", "evening", "tomorrow", "next-week"])
        precondition(presets[0].until == friday.addingTimeInterval(3_600) && presets[1].until == friday.addingTimeInterval(10_800))
        precondition(presets[2].until == date("2026-10-16T18:00:00+08:00"))
        precondition(presets[3].until == date("2026-10-17T09:00:00+08:00"))
        precondition(presets[4].until == date("2026-10-19T09:00:00+08:00"))
        precondition(!TaskSnooze.presets(now: date("2026-10-16T17:00:00+08:00"), calendar: zone).contains { $0.id == "evening" }, "Exactly one hour before evening must not duplicate the one-hour preset")
        precondition(!TaskSnooze.presets(now: date("2026-10-16T23:00:00+08:00"), calendar: zone).contains { $0.id == "evening" })
        let sunday = TaskSnooze.presets(now: date("2026-10-18T08:00:00+08:00"), calendar: zone)
        precondition(!sunday.contains { $0.id == "next-week" }, "Sunday's Tomorrow already is next Monday")
        let monday = TaskSnooze.presets(now: date("2026-10-19T08:00:00+08:00"), calendar: zone)
        precondition(monday.last?.until == date("2026-10-26T09:00:00+08:00"), "Monday always targets the following Monday, even before 9 AM")

        let pacific = calendar("America/Los_Angeles")
        for (now, next, elapsed) in [("2026-03-07T23:30:00-08:00", "2026-03-08T09:00:00-07:00", 8.5),
                                    ("2026-10-31T23:30:00-07:00", "2026-11-01T09:00:00-08:00", 10.5)] {
            let start = date(now); let tomorrow = TaskSnooze.presets(now: start, calendar: pacific).first { $0.id == "tomorrow" }!
            precondition(tomorrow.until == date(next) && tomorrow.until.timeIntervalSince(start) == elapsed * 3_600, "Tomorrow follows a calendar day through DST")
        }
        let skippedHour = date("2026-03-08T01:30:00-08:00")
        precondition(TaskSnooze.presets(now: skippedHour, calendar: pacific).first!.until == date("2026-03-08T03:30:00-07:00"), "One hour is an actual elapsed hour through DST")
        let beforeDST = date("2026-03-07T23:30:00-08:00")
        precondition(TaskSnooze.duration(amount: "1", unit: "days", now: beforeDST) == date("2026-03-09T00:30:00-07:00"), "Custom duration days are 24-hour periods across DST")
        precondition(TaskSnooze.duration(amount: "0.5", unit: "hours", now: friday) == friday.addingTimeInterval(1_800))
        for amount in ["", "0", "-1", "nan", "inf", "1e300", "abc", "0.000000001"] {
            precondition(TaskSnooze.duration(amount: amount, unit: "minutes", now: friday) == nil, "Invalid, out-of-range and sub-millisecond durations cannot reach the service")
        }
        precondition(TaskSnooze.duration(amount: "2", unit: "weeks", now: friday) == nil)
        let fractional = friday.addingTimeInterval(0.125)
        precondition(date(TaskSnooze.timestamp(fractional)) == fractional, "Sub-second durations retain millisecond precision in the request")

        let awake = try task(["snoozed": false, "snoozedUntil": "2026-10-19T03:00:00Z", "snoozeWakeAt": "2026-10-18T03:00:00Z", "settlementManaged": true])
        precondition(!TaskSnooze.isSnoozed(awake, now: .distantPast), "The host's early wake wins even if the client clock is behind")
        precondition(TaskWorkspaces.shelf(awake, now: .distantPast) == .active)
        let asleep = try task(["status": "running", "snoozed": true, "snoozedUntil": "2026-10-19T03:00:00Z"])
        precondition(TaskSnooze.isSnoozed(asleep, now: .distantFuture) && TaskWorkspaces.shelf(asleep, now: .distantFuture, workingShelfEnabled: true) == .snoozed, "Host clock and Snoozed shelf take precedence over active work")
        let legacy = try task(["snoozedUntil": "2026-10-19T03:00:00Z"])
        precondition(TaskSnooze.isSnoozed(legacy, now: date("2026-10-18T03:00:00Z")) && !TaskSnooze.isSnoozed(legacy, now: date("2026-10-19T03:00:00Z")))
        precondition(TaskSnooze.unseenWake(legacy) == nil && TaskSnooze.readChange(legacy) == nil, "Old hosts receive no unsupported wake receipts")
        precondition(TaskSnooze.unseenWake(awake) == "2026-10-18T03:00:00Z")
        let dismiss = TaskSnooze.readChange(awake, includingOutput: false)!
        precondition(dismiss["seenAt"] == nil && dismiss["seenWakeAt"] as? String == awake.snoozeWakeAt && dismiss["read"] as? Bool == true, "Dismiss only acknowledges the displayed wake")
        let visit = TaskSnooze.readChange(awake)!
        precondition(visit["seenAt"] as? String == awake.updatedAt && visit["seenWakeAt"] as? String == awake.snoozeWakeAt)
        var seen = awake; seen.seenSnoozeWakeAt = awake.snoozeWakeAt
        precondition(TaskSnooze.unseenWake(seen) == nil && TaskSnooze.readChange(seen) == nil)
        precondition(TaskSnooze.readIdentity(awake) != TaskSnooze.readIdentity(seen), "The selected detail acknowledges a new wake without waiting for output updatedAt to change")
        var newWake = seen; newWake.snoozeWakeAt = "2026-10-18T04:00:00Z"
        precondition(TaskSnooze.unseenWake(newWake) == newWake.snoozeWakeAt)
        var settled = newWake; settled.settledOverride = "settled"; settled.settledAt = "2026-10-18T04:00:00Z"
        precondition(TaskSnooze.unseenWake(settled) == nil)
        var unread = seen; unread.unread = true
        precondition(TaskSnooze.readChange(unread)?["seenAt"] as? String == unread.updatedAt)
        precondition(TaskSnooze.readChange(unread, includingOutput: false) == nil, "An already acknowledged wake cannot read unrelated unread output")
        print("Task Snooze: calendar presets, DST, host clock, early wake, legacy compatibility and scoped read receipts passed")
    }
}
