import Foundation

struct TaskQuestionDraft: Codable, Equatable {
    var selected: [String: [String]] = [:]
    var custom: [String: String] = [:]
    var index = 0

    func answers(for question: Question) -> [String] {
        if question.isOther != false || question.options.isEmpty,
           let text = custom[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { return [text] }
        let allowed = Set(question.options.map(\.answerValue))
        var values: [String] = []
        for value in selected[question.id] ?? [] where allowed.contains(value) && !values.contains(value) { values.append(value) }
        return question.multiSelect == true ? values : Array(values.prefix(1))
    }

    func complete(_ questions: [Question]) -> Bool { questions.allSatisfy { !answers(for: $0).isEmpty } }

    mutating func toggle(_ value: String, for question: Question) {
        custom[question.id] = nil
        if question.multiSelect == true {
            var values = selected[question.id] ?? []
            if let index = values.firstIndex(of: value) { values.remove(at: index) } else { values.append(value) }
            selected[question.id] = values
        } else { selected[question.id] = [value] }
    }

    func safeToCache(_ questions: [Question]) -> TaskQuestionDraft {
        var draft = self
        for question in questions where question.isSecret == true {
            draft.selected[question.id] = nil; draft.custom[question.id] = nil
        }
        return draft
    }
}
