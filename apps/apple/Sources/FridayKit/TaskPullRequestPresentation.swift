/*
Adapted from T3 Code 8cd9641f shared/threadPullRequests.ts.
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

enum TaskPullRequestPresentation {
    struct Line: Identifiable {
        let pullRequest: TaskPullRequest; let depth: Int; let chain: String; let stackSize: Int
        var id: String { TaskPullRequestPresentation.identity(pullRequest) }
    }
    struct Chain { let layers: [TaskPullRequest]; let depths: [Int] }
    struct Badge { let current: TaskPullRequest; let state: String; let count: Int; let stacked: Bool }
    static func scope(_ pr: TaskPullRequest) -> String {
        let parsed = URLComponents(string: pr.url)
        var host = (pr.host ?? parsed?.host ?? "").lowercased()
        if pr.host == nil, let port = parsed?.port { host += ":\(port)" }
        let path = parsed?.path ?? ""
        var repository = (pr.repository ?? path.replacingOccurrences(of: #"/(?:pull|pulls|pull-requests|pullrequest|-/merge_requests)/\d+(?:/.*)?$"#, with: "", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "/"))).lowercased()
        if pr.provider == "azure-devops" || host == "dev.azure.com" || host.hasSuffix(".visualstudio.com") {
            var parts = repository.split(separator: "/").map(String.init)
            if host.hasSuffix(".visualstudio.com") {
                if parts.first == "defaultcollection" { parts.removeFirst() }
                parts.insert(String(host.dropLast(".visualstudio.com".count)), at: 0)
            }
            if parts.count >= 4, let marker = parts.firstIndex(of: "_git"), marker > 0, marker + 1 < parts.count { repository = "\(parts[0])/\(parts[marker - 1])/_git/\(parts[marker + 1])"; host = "dev.azure.com" }
        }
        return host + "/" + repository
    }
    static func identity(_ pr: TaskPullRequest) -> String { scope(pr) + "#\(pr.number)" }
    static func visible(_ links: [TaskPullRequest]) -> [TaskPullRequest] {
        var seen = Set<String>(); return links.filter { $0.dismissedAt == nil && $0.linkSource != "stack-dismissed" && seen.insert(identity($0)).inserted }
    }
    private static func date(_ value: String?) -> Date { TaskChangeRequestTimeline.date(value ?? "") ?? .distantPast }
    private static func updated(_ pr: TaskPullRequest) -> Date { date(pr.snapshot?.updatedAt ?? pr.linkedAt) }
    private static func isOpen(_ pr: TaskPullRequest) -> Bool { pr.snapshot?.state == nil || pr.snapshot?.state == "open" }
    static func chains(_ links: [TaskPullRequest], stacks: [String: TaskChangeRequestStack?] = [:]) -> [Chain] {
        let links = visible(links); var chains: [Chain] = [], placed = Set<String>(), native: [String: [TaskPullRequest]] = [:], nativeOrder: [String] = []
        for pr in links {
            guard let stack = stacks[pr.url] ?? nil else { continue }
            let key = scope(pr) + "#stack:" + stack.id
            if native[key] == nil { nativeOrder.append(key) }; native[key, default: []].append(pr)
        }
        for key in nativeOrder {
            let members = native[key]!, stack = (stacks[members[0].url] ?? nil)!
            let order = Dictionary(stack.layers.enumerated().map { ($0.element.number, $0.offset) }, uniquingKeysWith: { a, _ in a })
            let sorted = members.enumerated().sorted { a, b in (order[a.element.number] ?? 0) == (order[b.element.number] ?? 0) ? a.offset < b.offset : (order[a.element.number] ?? 0) < (order[b.element.number] ?? 0) }.map(\.element)
            chains.append(Chain(layers: sorted, depths: Array(sorted.indices))); placed.formUnion(sorted.map(identity))
        }
        let remaining = links.filter { !placed.contains(identity($0)) }; var heads: [String: Int] = [:], parents: [Int: Int] = [:], children: [Int: [Int]] = [:]
        for (i, pr) in remaining.enumerated() {
            guard let snapshot = pr.snapshot else { continue }; let key = scope(pr) + ":" + snapshot.headBranch
            heads[key] = heads[key] == nil ? i : -1
        }
        for (i, pr) in remaining.enumerated() {
            guard let snapshot = pr.snapshot, let parent = heads[scope(pr) + ":" + snapshot.baseBranch], parent >= 0, parent != i else { continue }
            parents[i] = parent; children[parent, default: []].append(i)
        }
        for root in remaining.indices where parents[root] == nil {
            var pending = [(root, 0)], layers: [TaskPullRequest] = [], depths: [Int] = []
            while let (i, depth) = pending.popLast() {
                let pr = remaining[i]; guard placed.insert(identity(pr)).inserted else { continue }
                layers.append(pr); depths.append(depth)
                for child in (children[i] ?? []).reversed() { pending.append((child, depth + 1)) }
            }
            if !layers.isEmpty { chains.append(Chain(layers: layers, depths: depths)) }
        }
        for pr in remaining where !placed.contains(identity(pr)) { chains.append(Chain(layers: [pr], depths: [0])); placed.insert(identity(pr)) }
        return chains
    }
    static func lines(_ links: [TaskPullRequest], stacks: [String: TaskChangeRequestStack?] = [:]) -> [Line] {
        chains(links, stacks: stacks).enumerated().sorted { a, b in
            let left = a.element.layers.map(updated).max() ?? .distantPast, right = b.element.layers.map(updated).max() ?? .distantPast
            return left == right ? a.offset < b.offset : left > right
        }.flatMap { pair in
            let chain = pair.element, key = identity(chain.layers[0])
            return chain.layers.enumerated().map { Line(pullRequest: $0.element, depth: chain.depths[$0.offset], chain: key, stackSize: $0.offset == 0 ? chain.layers.count : 0) }
        }
    }
    static func badge(_ raw: [TaskPullRequest], stacks: [String: TaskChangeRequestStack?] = [:], branch: TaskPullRequest? = nil) -> Badge? {
        let links = visible(raw).isEmpty ? branch.map { [$0] } ?? [] : visible(raw)
        guard !links.isEmpty else { return nil }
        let open = links.filter(isOpen), groups = chains(links, stacks: stacks)
        func top(_ chain: Chain, onlyOpen: Bool) -> TaskPullRequest? {
            chain.layers.enumerated().filter { !onlyOpen || isOpen($0.element) }.sorted { a, b in chain.depths[a.offset] == chain.depths[b.offset] ? a.offset > b.offset : chain.depths[a.offset] > chain.depths[b.offset] }.first?.element
        }
        let current: TaskPullRequest
        if open.count == 1 { current = open[0] }
        else if open.count > 1 {
            current = groups.filter { $0.layers.contains(where: isOpen) }.sorted { a, b in (a.layers.map { date($0.linkedAt) }.max() ?? .distantPast) > (b.layers.map { date($0.linkedAt) }.max() ?? .distantPast) }.first.flatMap { top($0, onlyOpen: true) } ?? open[0]
        } else if groups.count == 1 { current = top(groups[0], onlyOpen: false) ?? links[0] }
        else { current = links.sorted { updated($0) > updated($1) }[0] }
        let state = links.allSatisfy { $0.snapshot?.state == "open" && $0.snapshot?.isDraft == true } ? "draft" : !open.isEmpty ? "open" : links.allSatisfy { $0.snapshot?.state == "merged" } ? "merged" : "closed"
        return Badge(current: current, state: state, count: links.count, stacked: links.count > 1 && groups.count == 1)
    }
}
