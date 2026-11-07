import Foundation

extension TaskChangeRequestStack {
    func plan(action: String, current: Int, method: String) -> TaskStackActionPlan? {
        guard let index = layers.firstIndex(where: { $0.number == current }), action == "merge" || action == "update-branch" else { return nil }
        let affected = (action == "merge" ? Array(layers.prefix(index + 1)) : layers).filter { $0.state != "merged" }
        guard !affected.isEmpty, affected.allSatisfy({ $0.state == "open" && $0.headSha?.isEmpty == false }),
              action != "merge" || layers[index].state == "open" && affected.allSatisfy({ $0.isDraft != true }),
              let target = action == "merge" ? layers[index] : layers.last, let head = target.headSha else { return nil }
        return TaskStackActionPlan(action: action, stackNumber: number, base: base, targetNumber: target.number, headSha: head,
            heads: affected.map { TaskStackHead(number: $0.number, headSha: $0.headSha!) }, layers: affected, mergeMethod: method)
    }
}
struct TaskStackHead: Codable, Equatable { let number: Int; let headSha: String }
struct TaskChangeRequestStackResponse: Decodable { let stack: TaskChangeRequestStack? }
struct TaskStackOpenResponse: Decodable { let url: String }
struct TaskStackActionPlan: Identifiable {
    let id = UUID(); let action: String; let stackNumber: Int; let base: String; let targetNumber: Int; let headSha: String
    let heads: [TaskStackHead]; let layers: [TaskChangeRequestStack.Layer]; var mergeMethod: String
    var label: String { action == "merge" ? "合并堆叠" : "整栈变基" }
}
