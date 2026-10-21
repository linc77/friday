import Foundation
#if os(macOS)
import AppKit
#endif

@main struct TaskComposerCommandTests {
    struct Fixture: Decodable {
        let sourceRevision: String; let catalog: TaskComposerCatalog; let cases: [Case]
        let modeCases: [ModeCase]
        let feedbackCases: [ModeCase]
        struct ModeCase: Decodable { let text: String; let expected: String? }
        struct Case: Decodable { let kind: String; let query: String; let atStart: Bool; let showSkills: Bool; let compactAvailable: Bool; let expected: [String] }
    }
    static func main() throws {
        let path = CommandLine.arguments[1]
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        precondition(fixture.sourceRevision == "8cd9641f76874f2ce17d6c80acd71fab1f0b99d3")
        for value in fixture.modeCases { precondition(TaskComposerCommands.standaloneMode(value.text) == value.expected, "Standalone mode: \(value.text)") }
        for value in fixture.feedbackCases { precondition(TaskComposerCommands.feedback(value.text) == value.expected, "Feedback boundary: \(value.text)") }
        let goal = TaskProviderGoal(objective: "Finish the task", status: "active", tokensUsed: 1250, timeUsedSeconds: 65)
        precondition(goal.title(working: true) == "正在执行目标" && goal.title(working: false) == "目标已设定" && !goal.canResume && goal.usage == "1k tokens · 1m")
        let target = TaskUsageResetTarget(sourceId: "hub", accountId: "account", creditId: "shown-credit", fingerprint: String(repeating: "a", count: 64))
        let retainedTarget = try JSONDecoder().decode(TaskUsageResetTarget.self, from: JSONEncoder().encode(target))
        precondition(retainedTarget == target && retainedTarget.body["creditId"] as? String == "shown-credit" && retainedTarget.body["confirmed"] as? Bool == true)
        let reset = TaskProviderResetSubmission(provider: "codex", fingerprint: String(repeating: "a", count: 64))
        let recovered = try JSONDecoder().decode(TaskProviderResetSubmission.self, from: JSONEncoder().encode(reset))
        precondition(recovered.requestId == reset.requestId && recovered.body["confirmed"] as? Bool == true)
        for value in fixture.cases {
            let query = TaskMentionQuery(text: value.query, range: NSRange(location: value.atStart ? 0 : 12, length: value.query.utf16.count + 1), source: "/" + value.query, kind: value.kind)
            let actual = TaskComposerCommands.options(query, catalog: fixture.catalog, showSkills: value.showSkills, compactAvailable: value.compactAvailable).map(\.id)
            precondition(actual == value.expected, "\(value.kind) \(value.query) start=\(value.atStart) skills=\(value.showSkills): \(actual) != \(value.expected)")
        }
        let body = "🙂 开始 /pl", location = (body as NSString).length
        let piCommands = TaskComposerCommands.options(TaskMentionQuery(text: "", range: NSRange(location: 0, length: 1), source: "/", kind: "slash"), catalog: nil, showSkills: true, compactAvailable: false, provider: "pi")
        precondition(piCommands.contains { $0.path == "builtin:model" })
        precondition(!piCommands.contains { ["builtin:plan", "builtin:default"].contains($0.path) }, "Pi does not advertise native interaction modes, including before its catalog loads")
        let grokCommands = TaskComposerCommands.options(TaskMentionQuery(text: "", range: NSRange(location: 0, length: 1), source: "/", kind: "slash"), catalog: nil, showSkills: true, compactAvailable: false, provider: "grok")
        precondition(grokCommands.contains { $0.path == "builtin:model" } && !grokCommands.contains { ["builtin:plan", "builtin:default"].contains($0.path) }, "Grok ACP does not expose native interaction modes")
        let query = TaskComposerCommands.trigger(body, at: location)!
        precondition(query.kind == "slash" && query.text == "pl" && (body as NSString).substring(with: query.range) == "/pl")
        precondition(TaskComposerCommands.trigger("https://example.test", at: 20) == nil)
        precondition(TaskComposerCommands.trigger("budget $100K", at: 12) == nil)
        precondition(TaskComposerCommands.trigger("€review", at: 7)?.kind == "skill")
        let known = TaskComposerCommands.skillOccurrences("$review then €2spec; $100K $2spec", skills: fixture.catalog.skills)
        precondition(known.map { $0.skill.name } == ["review", "2spec"], "Currency, punctuation and enabled catalog membership use the pinned token shape")
        let usage = TaskContextUsage(usedTokens: 250, maxTokens: 100, updatedAt: "now")
        precondition(usage.fraction == 1 && usage.remainingTokens == 0)
        precondition(usage.percentageText == "100%" && TaskContextUsage(usedTokens: 96, maxTokens: 1000, updatedAt: "now").percentageText == "9.6%")
        precondition(TaskContextUsage(usedTokens: 0, maxTokens: nil, updatedAt: "now").fraction == nil)
        precondition(TaskContextUsage.format(100500) == "101k" && TaskContextUsage.format(999500) == "1m" && TaskContextUsage.format(nil) == "—")
        let at = Date(timeIntervalSince1970: 2_000_000_000)
        var stale = TaskContextUsage(usedTokens: 100_000, maxTokens: nil, updatedAt: ISO8601DateFormatter().string(from: at))
        precondition(!stale.offersResumeCompaction(provider: "claude", now: at.addingTimeInterval(4199)))
        precondition(stale.offersResumeCompaction(provider: "claude", now: at.addingTimeInterval(4200)))
        precondition(!stale.offersResumeCompaction(provider: "codex", now: at.addingTimeInterval(99999)))
        stale.promptCacheTtlMs = 300_000
        precondition(!stale.offersResumeCompaction(provider: "claude", now: at.addingTimeInterval(299)))
        precondition(stale.offersResumeCompaction(provider: "claude", now: at.addingTimeInterval(300)))
        precondition(!TaskContextUsage(usedTokens: 99_999, maxTokens: nil, updatedAt: stale.updatedAt).offersResumeCompaction(provider: "claude", now: at.addingTimeInterval(99999)))
        let limits = TaskComposerCommands.trigger("/usage-limits", at: 13)!
        precondition(!TaskComposerCommands.options(limits, catalog: fixture.catalog, showSkills: true, compactAvailable: true).contains { $0.path == "command:usage-limits" })
        precondition(TaskComposerCommands.options(limits, catalog: fixture.catalog, showSkills: true, compactAvailable: true, usageLimitsAvailable: true).first?.path == "command:usage-limits")
        let mid = TaskMentionQuery(text: limits.text, range: NSRange(location: 5, length: limits.range.length), source: limits.source, kind: limits.kind)
        precondition(!TaskComposerCommands.options(mid, catalog: fixture.catalog, showSkills: true, compactAvailable: true, usageLimitsAvailable: true).contains { $0.path == "command:usage-limits" })
        #if os(macOS)
        try textCodec(fixture.catalog)
        #endif
        print("\(fixture.cases.count) independent pinned T3 search vectors, \(fixture.modeCases.count) standalone mode cases, \(fixture.feedbackCases.count) feedback cases, goals, stable reset scope, prompt position, skill visibility, UTF-16 triggers, money exclusions and context formatting passed")
    }
    #if os(macOS)
    static func textCodec(_ catalog: TaskComposerCatalog) throws {
        let text = "🙂 $review then $2spec and $100K", font = NSFont.systemFont(ofSize: 14)
        let document = TaskContextText.document(text, records: [], skills: catalog.skills, font: font)
        precondition(TaskContextText.canonical(document) == text && document.length < text.utf16.count)
        let raw = NSAttributedString(string: text), edits = TaskContextText.skillEdits(raw, skills: catalog.skills, records: [], font: font)
        precondition(edits.count == 2)
        let formatted = NSMutableAttributedString(attributedString: raw)
        for edit in edits { formatted.replaceCharacters(in: edit.range, with: edit.replacement) }
        precondition(TaskContextText.canonical(formatted) == text && TaskContextText.skillEdits(formatted, skills: catalog.skills, records: [], font: font).isEmpty)
        let caret = text.utf16.count
        precondition(TaskContextText.modelRange(TaskContextText.viewRange(NSRange(location: caret, length: 0), in: formatted), in: formatted).location == caret)
        let changed = NSMutableAttributedString(attributedString: TaskContextText.document("$review", records: [], skills: catalog.skills, font: font))
        changed.append(NSAttributedString(string: "xyz"))
        let plain = TaskContextText.skillEdits(changed, skills: catalog.skills, records: [], font: font)
        precondition(plain.count == 1)
        for edit in plain { changed.replaceCharacters(in: edit.range, with: edit.replacement) }
        precondition(changed.string == "$reviewxyz" && TaskContextText.canonical(changed) == "$reviewxyz")
        let object: [String: Any] = ["id": "ref", "kind": "file", "label": "has $review words", "capturedAt": "now", "digest": "fixture", "byteLength": 1]
        let reference = try JSONDecoder().decode(TaskContextReference.self, from: JSONSerialization.data(withJSONObject: object)), token = TaskContextDocument.token(reference)
        let protected = TaskContextText.document(token, records: [reference], skills: catalog.skills, font: font)
        precondition(protected.length == 1 && TaskContextText.canonical(protected) == token)
        precondition(TaskContextText.skillEdits(protected, skills: catalog.skills, records: [reference], font: font).isEmpty)
        let query = TaskComposerCommands.trigger("/mo", at: 3)!
        var insertion = TaskContextInsertion(replacing: query, identity: "scope"); insertion.plainText = "/model "
        precondition(insertion.shouldInsert(in: "/mo") && !insertion.shouldInsert(in: "/pl"))
        precondition(TaskContextDocument.insertionText(insertion, text: "/mo") == "/model ")
        print("Atomic skill labels, canonical copy, UTF-16 caret mapping, editing to unknown names, protected references and stale command replacement passed")
    }
    #endif
}
