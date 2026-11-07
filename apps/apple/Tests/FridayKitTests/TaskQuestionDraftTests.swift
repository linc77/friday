import Foundation

@main
struct TaskQuestionDraftTests {
    static func main() throws {
        let single = Question(id: "one", header: "One", question: "Choose", options: [QuestionOption(label: "A", description: "First"), QuestionOption(label: "B", description: "Second")])
        var multiple = single; multiple.multiSelect = true
        var draft = TaskQuestionDraft()
        precondition(!draft.complete([single]))
        draft.toggle("A", for: single); draft.toggle("B", for: single)
        precondition(draft.answers(for: single) == ["B"], "Single-choice selections replace each other")
        draft.toggle("A", for: multiple)
        precondition(draft.answers(for: multiple) == ["B", "A"])
        draft.toggle("B", for: multiple)
        precondition(draft.answers(for: multiple) == ["A"], "Multi-choice selections toggle independently")
        draft.custom["one"] = "  Custom answer  "
        precondition(draft.answers(for: multiple) == ["Custom answer"], "A custom answer takes precedence over stale option picks")
        draft.toggle("B", for: single)
        precondition(draft.custom["one"] == nil && draft.answers(for: single) == ["B"])
        var restricted = single; restricted.isOther = false
        draft.custom["one"] = "Not allowed"
        precondition(draft.answers(for: restricted) == ["B"], "A cached custom answer cannot bypass the question's capabilities")
        draft.selected["one"] = ["gone", "A", "A", "B"]
        draft.custom["one"] = nil
        precondition(draft.answers(for: multiple) == ["A", "B"], "Stale or duplicate cached options are removed")
        precondition(draft.answers(for: single) == ["A"])
        var secret = single; secret.isSecret = true
        draft.custom["one"] = "private credential"
        precondition(draft.safeToCache([secret]).selected["one"] == nil && draft.safeToCache([secret]).custom["one"] == nil,
                     "Secret answers must not enter the task draft cache")
        let saved = try JSONEncoder().encode(draft.safeToCache([secret]))
        precondition(!String(decoding: saved, as: UTF8.self).contains("private credential"))
        let legacy = try JSONDecoder().decode(Question.self, from: Data(#"{"id":"legacy","header":"","question":"Question","options":[]}"#.utf8))
        precondition(legacy.multiSelect == nil && legacy.isOther == nil && legacy.isSecret == nil)
        let native = try JSONDecoder().decode(Question.self, from: Data(#"{"id":"native","header":"","question":"Pick","isOther":false,"options":[{"label":"Same","description":"First","value":"native-a"},{"label":"Same","description":"Second","value":"native-b"}]}"#.utf8))
        var nativeDraft = TaskQuestionDraft(); nativeDraft.toggle(native.options[1].answerValue, for: native)
        precondition(nativeDraft.answers(for: native) == ["native-b"], "Native option IDs must remain distinct when labels match")
        let oldApproval = try JSONDecoder().decode(Approval.self, from: Data(#"{"id":"old","method":"approval","title":"Approval","detail":"","questions":[],"state":"pending"}"#.utf8))
        precondition(oldApproval.canRespond && oldApproval.effectiveOptions.map(\.decision) == ["decline", "accept"], "Older hosts must not offer unsupported session grants")
        var approval = try JSONDecoder().decode(Approval.self, from: Data(#"{"id":"new","method":"mcpServer/elicitation/request","title":"Approval","detail":"","questions":[],"state":"pending","decisions":["accept","decline"],"appName":"Safari","options":[{"decision":"cancel","label":"Cancel"},{"decision":"acceptForSession","label":"Allow this window"},{"decision":"acceptAlways","label":"Always allow"},{"decision":"accept","label":"Approve"}]}"#.utf8))
        precondition(approval.effectiveOptions.map(\.decision) == ["cancel", "acceptForSession", "acceptAlways", "accept"] && approval.appName == "Safari", "Native consent must keep exactly the advertised persistence choices")
        precondition(approval.label(approval.effectiveOptions[1]) == "Allow this window", "Provider-specific consent labels must survive decoding")
        precondition(approval.label(approval.effectiveOptions[2]) == "始终允许")
        approval.responseStatus = "sending"; precondition(!approval.canRespond)
        approval.responseStatus = "uncertain"; precondition(!approval.canRespond)
        approval.responseStatus = "sent"; approval = Approval(id: "answered", method: "approval", title: "Approval", detail: "", questions: [], state: "answered")
        precondition(!approval.canRespond)
        print("Question selection, custom answers, capability validation, secret draft exclusion, consent choices, uncertain replies and legacy decoding passed")
    }
}
