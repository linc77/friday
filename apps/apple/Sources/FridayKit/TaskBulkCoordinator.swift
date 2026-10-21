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
import Combine

struct TaskBulkOutcome {
    var succeeded: Set<String> = []
    var failures: [String: String] = [:]
}

/// Owns only the client's pending HTTP requests. Accepted work remains owned
/// by the service; neither view dismissal nor a retry replays model requests.
@MainActor final class TaskBulkCoordinator: ObservableObject {
    @Published private(set) var plan: TaskBulkPlan?
    @Published private(set) var busy = false
    @Published private(set) var processed = 0
    @Published private(set) var outcome = TaskBulkOutcome()
    private var generation = UUID()

    func reset() {
        generation = UUID(); plan = nil; busy = false; processed = 0; outcome = TaskBulkOutcome()
    }
    func acknowledgeMissingDeletes(available: Set<String>) {
        guard !busy, let plan, plan.action == .delete else { return }
        for id in plan.taskIDs where !available.contains(id) {
            outcome.succeeded.insert(id); outcome.failures.removeValue(forKey: id)
        }
        processed = outcome.succeeded.count + outcome.failures.count
    }
    private enum Attempt { case succeeded(String), failed(String, String), retired }

    func run(_ next: TaskBulkPlan, isCurrent: @escaping @MainActor () -> Bool,
             perform: @escaping @MainActor (TaskBulkMutation) async throws -> Void) async -> TaskBulkOutcome? {
        guard !busy, isCurrent() else { return nil }
        if plan?.id != next.id { outcome = TaskBulkOutcome(); processed = 0 }
        plan = next; busy = true; let token = UUID(); generation = token
        defer { if generation == token { busy = false } }
        let pending = next.taskIDs.filter { !outcome.succeeded.contains($0) }
        // Titles stop at their first failure like T3. Deletes continue and keep
        // failed rows selected; independent metadata can travel four at a time.
        let width = next.action == .regenerateTitle || next.action == .delete ? 1 : 4
        for offset in stride(from: 0, to: pending.count, by: width) {
            guard generation == token, isCurrent() else { if generation == token { reset() }; return nil }
            let ids = Array(pending[offset..<min(pending.count, offset + width)])
            let jobs = ids.map { id in
                Task { @MainActor () -> Attempt in
                    guard self.generation == token, isCurrent() else { return .retired }
                    guard let mutation = next.request(for: id) else { return .failed(id, "批量操作参数无效") }
                    do { try await perform(mutation); return .succeeded(id) }
                    catch is CancellationError { return .retired }
                    catch { return .failed(id, error.localizedDescription) }
                }
            }
            var stop = false
            for job in jobs {
                let result = await job.value
                guard generation == token, isCurrent() else { if generation == token { reset() }; return nil }
                switch result {
                case .succeeded(let id): outcome.succeeded.insert(id); outcome.failures.removeValue(forKey: id)
                case .failed(let id, let error):
                    outcome.failures[id] = error
                    if next.action == .regenerateTitle { stop = true }
                case .retired: reset(); return nil
                }
                processed = outcome.succeeded.count + outcome.failures.count
            }
            if stop { break }
        }
        return outcome
    }
}
