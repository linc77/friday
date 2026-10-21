/*
Adapted from T3 Code 8cd9641f composerSlashCommandSearch.ts, providerSkillSearch.ts, searchRanking.ts and inlineSkills.ts.
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

struct TaskComposerCatalog: Decodable {
    struct Skill: Decodable, Equatable {
        let name: String; let path: String; let enabled: Bool
        var description: String? = nil; var shortDescription: String? = nil; var scope: String? = nil; var displayName: String? = nil
        var userInvocable: Bool? = nil; var userInvocationOnly: Bool? = nil
    }
    struct Command: Decodable { let name: String; var description: String? = nil; var argumentHint: String? = nil }
    let provider: String; let cwd: String; let checkedAt: String; let skills: [Skill]; let commands: [Command]
    var supportsPlan: Bool? = nil
}

enum TaskComposerCommands {
    struct SkillOccurrence { let range: NSRange; let skill: TaskComposerCatalog.Skill }
    static func skillOccurrences(_ text: String, skills: [TaskComposerCatalog.Skill]) -> [SkillOccurrence] {
        let pattern = #"(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)"#
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
        let source = text as NSString
        return expression.matches(in: text, range: NSRange(location: 0, length: source.length)).compactMap { match in
            let name = source.substring(with: match.range(at: 2))
            guard let skill = skills.first(where: { $0.name == name }) else { return nil }
            let start = match.range.location + match.range(at: 1).length
            return SkillOccurrence(range: NSRange(location: start, length: NSMaxRange(match.range) - start), skill: skill)
        }
    }
    static func trigger(_ text: String, at offset: Int) -> TaskMentionQuery? {
        let source = text as NSString
        guard offset >= 0, offset <= source.length else { return nil }
        let prefix = source.substring(to: offset) as NSString
        for (kind, pattern) in [("slash", #"(?:^|\s)(/[^\s/]{0,200})$"#),
                                ("skill", #"(?:^|\s)(\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?$)[a-zA-Z0-9:_-]{0,200})$"#)] {
            guard let expression = try? NSRegularExpression(pattern: pattern), let match = expression.firstMatch(in: prefix as String, range: NSRange(location: 0, length: prefix.length)) else { continue }
            let range = match.range(at: 1), token = source.substring(with: range)
            return TaskMentionQuery(text: String(token.dropFirst()), range: range, source: token, kind: kind)
        }
        return nil
    }
    // ECMAScript trim()/\s: includes BOM, excludes NEL. Match T3's parser.
    static let commandWhitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    static func feedback(_ text: String) -> String? {
        let command = text.trimmingCharacters(in: commandWhitespace)
        guard command.lowercased().hasPrefix("/feedback") else { return nil }
        let suffix = command.dropFirst(9)
        guard suffix.isEmpty || suffix.unicodeScalars.first.map({ commandWhitespace.contains($0) }) == true else { return nil }
        return command
    }
    static func standaloneMode(_ text: String) -> String? {
        let command = text.trimmingCharacters(in: commandWhitespace).lowercased()
        return command == "/plan" ? "plan" : command == "/default" ? "default" : nil
    }
    static func options(_ query: TaskMentionQuery, catalog: TaskComposerCatalog?, showSkills: Bool, compactAvailable: Bool, usageLimitsAvailable: Bool = false, provider: String? = nil) -> [TaskFileEntry] {
        var seen: Set<String> = []
        let skills = (catalog?.skills ?? []).filter { $0.enabled && $0.userInvocable != false && seen.insert($0.name.trimmingCharacters(in: .whitespaces).lowercased()).inserted }
        let skillRows = skills.map { TaskFileEntry(path: "skill:" + $0.name, name: query.kind == "skill" ? displayName($0) : "/skill:" + $0.name, kind: "skill", detail: $0.shortDescription ?? $0.description ?? $0.scope.map { $0 + " skill" }) }
        var rows: [TaskFileEntry] = []
        if query.kind == "slash" {
            rows = [("model", "Switch response model for this thread"), ("plan", "Switch this thread into plan mode"), ("default", "Switch this thread back to normal build mode")].filter { (provider ?? catalog?.provider).map(TaskProviderCatalog.supportsInteractionModes) != false || catalog?.supportsPlan == true || $0.0 == "model" }.map {
                TaskFileEntry(path: "builtin:" + $0.0, name: "/" + $0.0, kind: "builtin", detail: $0.1)
            }
            if query.range.location == 0 {
                let hiddenSkills = Set(showSkills ? skills.map { $0.name.lowercased() } : [])
                let commands = (catalog?.commands ?? []).filter { $0.name != "usage-limits" || !usageLimitsAvailable }
                    + (usageLimitsAvailable ? [.init(name: "usage-limits", description: "Show this provider's usage limits")] : [])
                rows += commands.filter { !hiddenSkills.contains($0.name.lowercased()) && ($0.name != "compact" || compactAvailable) }.map {
                    TaskFileEntry(path: "command:" + $0.name, name: "/" + $0.name, kind: "provider-command", detail: $0.description ?? $0.argumentHint)
                }
            }
            if showSkills { rows += skillRows }
        } else { rows = skillRows }
        let normalized = query.text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: query.kind == "slash" ? #"^/+"# : #"^\p{Sc}+"#, with: "", options: .regularExpression).lowercased()
        guard !normalized.isEmpty else { return rows }
        return rows.compactMap { row -> (TaskFileEntry, Int)? in
            let name = String(row.path.split(separator: ":", maxSplits: 1).last ?? "").lowercased()
            let needle = row.kind == "skill" && query.kind == "slash" && normalized.hasPrefix("skill:") ? String(normalized.dropFirst(6)) : normalized
            if row.kind == "skill" && query.kind == "slash" && ["skill", "skill:"].contains(normalized) { return (row, 0) }
            var scores = [score(name, query: needle), score((row.detail ?? "").lowercased(), query: needle, base: 20, fuzzy: nil, markers: [" ", "-", "_", "/"])].compactMap { $0 }
            if row.kind == "skill", let skill = skills.first(where: { "skill:" + $0.name == row.path }) {
                scores = [score(name, query: needle), score(displayName(skill).lowercased(), query: needle, base: 1, fuzzy: 110, markers: [" ", "-", "_", "/"]),
                    score((skill.shortDescription ?? "").lowercased(), query: needle, base: 20, fuzzy: nil, markers: [" ", "-", "_", "/"]),
                    score((skill.description ?? "").lowercased(), query: needle, base: 30, fuzzy: nil, markers: [" ", "-", "_", "/"]),
                    score((skill.scope ?? "").lowercased(), query: needle, base: 40, fuzzy: nil, boundary: false)].compactMap { $0 }
            }
            if let score = scores.min() { return (row, score) }
            if row.kind == "skill", query.kind == "slash", "skill".hasPrefix(normalized) { return (row, Int.max) }
            return nil
        }.sorted { left, right in
            if left.1 != right.1 { return left.1 < right.1 }
            if query.kind == "skill" {
                let label = { (row: TaskFileEntry) in row.name.lowercased() + "\0" + row.path }
                return label(left.0).compare(label(right.0), locale: Locale(identifier: "en_US")) == .orderedAscending
            }
            let rank = { (row: TaskFileEntry) in (row.kind == "builtin" ? "0" : row.kind == "provider-command" ? "1" : "2") + row.path }
            return rank(left.0) < rank(right.0)
        }.map(\.0)
    }
    static func displayName(_ skill: TaskComposerCatalog.Skill) -> String {
        if let label = skill.displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty { return label }
        return skill.name.components(separatedBy: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ":_-")))
            .filter { !$0.isEmpty }.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
    private static func score(_ value: String, query: String, base: Int = 0, fuzzy: Int? = 100, markers: [String] = ["-", "_", "/"], boundary: Bool = true) -> Int? {
        guard !value.isEmpty, !query.isEmpty else { return nil }
        let text = value as NSString, needle = query as NSString
        let penalty = min(64, max(0, text.length - needle.length))
        if value == query { return base }
        if value.hasPrefix(query) { return base + 2 + penalty }
        if boundary {
            let indices = markers.compactMap { marker -> Int? in
                let found = text.range(of: marker + query)
                return found.location == NSNotFound ? nil : found.location + (marker as NSString).length
            }
            if let index = indices.min() { return base + 4 + index * 2 + penalty }
        }
        let found = text.range(of: query)
        if found.location != NSNotFound { return base + (boundary ? 6 : 4) + found.location * 2 + penalty }
        guard let fuzzy else { return nil }
        let values = Array(value.utf16), letters = Array(query.utf16)
        var cursor = 0, first = -1, previous = -1, gap = 0
        for index in values.indices where values[index] == letters[cursor] {
            if first == -1 { first = index }
            if previous != -1 { gap += index - previous - 1 }
            previous = index; cursor += 1
            if cursor == letters.count {
                return fuzzy + first * 2 + gap * 3 + (index - first + 1 - letters.count) + min(64, values.count - letters.count)
            }
        }
        return nil
    }
}
