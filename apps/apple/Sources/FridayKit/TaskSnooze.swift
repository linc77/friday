/*
 * Calendar presets follow pingdotgg/t3code
 * edb21555667dc926bec3f8b2fac41db817b16ae9/packages/client-runtime/src/state/threadSettled.ts
 * MIT License — Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import Foundation

enum TaskSnooze {
    struct Preset: Identifiable {
        let id: String
        let label: String
        let until: Date
    }

    static func duration(amount: String, unit: String, now: Date) -> Date? {
        guard let amount = Double(amount.trimmingCharacters(in: .whitespacesAndNewlines)), amount.isFinite, amount > 0,
              let seconds = ["minutes": 60.0, "hours": 3_600.0, "days": 86_400.0][unit] else { return nil }
        // Match JavaScript Date's range and millisecond precision. Duration days
        // mean elapsed 24-hour periods, while Tomorrow uses the local calendar.
        let value = (now.timeIntervalSince1970 + amount * seconds) * 1_000
        guard value.isFinite, abs(value) <= 8.64e15 else { return nil }
        let date = Date(timeIntervalSince1970: value.rounded(.towardZero) / 1_000)
        return date > now ? date : nil
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func presets(now: Date, calendar: Calendar = .current) -> [Preset] {
        var result = [Preset(id: "hour", label: "一小时后", until: now.addingTimeInterval(3_600)),
                      Preset(id: "three-hours", label: "三小时后", until: now.addingTimeInterval(10_800))]
        func atHour(_ hour: Int, days: Int = 0) -> Date? {
            guard let day = calendar.date(byAdding: .day, value: days, to: now) else { return nil }
            return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)
        }
        if let evening = atHour(18), evening.timeIntervalSince(now) > 3_600 {
            result.append(.init(id: "evening", label: "今晚 6 点", until: evening))
        }
        let tomorrow = atHour(9, days: 1)
        if let tomorrow { result.append(.init(id: "tomorrow", label: "明天上午 9 点", until: tomorrow)) }
        let days = (2 - calendar.component(.weekday, from: now) + 7) % 7
        if let monday = atHour(9, days: days == 0 ? 7 : days), monday != tomorrow {
            result.append(.init(id: "next-week", label: "下周一上午 9 点", until: monday))
        }
        return result
    }

    static func isSnoozed(_ task: WorkItem, now: Date) -> Bool {
        if let snoozed = task.snoozed { return snoozed }
        // Old hosts do not support early wakes or authoritative clock metadata.
        return !task.active && (CodexTranscript.date(task.snoozedUntil).map { $0 > now } ?? false)
    }

    static func unseenWake(_ task: WorkItem) -> String? {
        guard task.archivedAt == nil, task.settledAt == nil, task.settledOverride != "settled", task.snoozed != true,
              let wake = task.snoozeWakeAt, let at = CodexTranscript.date(wake) else { return nil }
        if let seen = CodexTranscript.date(task.seenSnoozeWakeAt), seen >= at { return nil }
        return wake
    }

    static func readChange(_ task: WorkItem, includingOutput: Bool = true) -> [String: Any]? {
        let wake = unseenWake(task)
        guard task.localAgent, includingOutput && task.unread == true || wake != nil else { return nil }
        var body: [String: Any] = ["read": true]
        if includingOutput { body["seenAt"] = task.updatedAt }
        if let wake { body["seenWakeAt"] = wake }
        return body
    }

    static func readIdentity(_ task: WorkItem) -> String {
        // Explicitly marking the open task unread must survive until the next
        // visit or new output. The acknowledgement itself is not a new visit.
        [task.updatedAt, task.snoozeWakeAt ?? "", task.seenSnoozeWakeAt ?? ""].joined(separator: "\n")
    }
}
