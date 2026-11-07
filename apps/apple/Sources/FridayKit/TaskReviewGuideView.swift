import SwiftUI

struct TaskReviewGuideView: View {
    @ObservedObject var store: FridayStore
    let taskID: String; let url: String; let detail: TaskChangeRequestDetail
    let canComment: Bool; let pendingComments: [TaskRemoteReviewDraft]; let removeComment: (UUID) -> Void
    let comment: (String, TaskGuideExcerptSnapshot, TaskGuideExcerptSnapshot.Line, String) -> Void
    let refreshDetail: () -> Void
    let openFile: (String) -> Void
    let finishReview: () -> Void
    @State private var response: TaskReviewGuideResponse?
    @State private var loading = false
    @State private var sending = false
    @State private var error: String?
    @State private var notice: String?
    @State private var owner = UUID()
    @State private var loadToken = UUID()
    @State private var progress = TaskGuideProgress()
    @State private var loadedProgress = ""
    @State private var loadedScope = ""
    @State private var request: (id: String, head: String)?
    @State private var handoffBusy = false
    @State private var handoffID: UUID?
    private var scope: String { store.connectionIdentity + "|" + taskID + "|" + url }
    private var runRevision: String {
        var values: [String] = []
        for task in store.tasks { for run in task.changeRequestGuideRuns ?? [] where run.url == url { values.append(run.id + run.updatedAt + run.status) } }
        return values.sorted().joined(separator: "|")
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Guide").font(.headline)
                if let guide = response?.guide { Text("\(progress.seen.filter { $0 >= 0 && $0 < guide.stops.count }.count) / \(guide.stops.count)").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                if let run = response?.run, run.active {
                    Text(friday: "正在只读调查变更…").font(.caption).foregroundStyle(.secondary)
                    Button(friday: "停止生成") { cancel(run.id) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(sending || !store.connected)
                } else {
                    Button { generate() } label: { FridaySymbolLabel(friday: request != nil ? "重试生成" : response?.guide == nil ? "生成 Guide" : "重写 Guide", systemImage: "sparkles") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(loading || sending || !store.connected)
                }
            }.padding(12)
            Divider()
            ViewThatFits(in: .horizontal) {
                if let guide = response?.guide, !guide.stops.isEmpty {
                    HStack(spacing: 0) { rail(guide).frame(width: 210); Divider(); tourContent(showMenu: false).frame(minWidth: 650) }.frame(minWidth: 900)
                }
                tourContent(showMenu: true)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .focusable().focusEffectDisabled()
        .onKeyPress(keys: ["j", "k"]) { key in guard key.modifiers.isEmpty else { return .ignored }; step(key.characters == "j" ? 1 : -1); return .handled }
        .task(id: scope + "|" + detail.headSha + "|" + runRevision) {
            if loadedScope != scope { loadedScope = scope; owner = UUID(); response = nil; error = nil; request = nil; loadedProgress = "" }
            await load()
        }
        .task(id: response?.run?.id) {
            while !Task.isCancelled, response?.run?.active == true {
                try? await Task.sleep(for: .seconds(2)); if Task.isCancelled { return }
                let generation = owner, identity = scope
                do {
                    let status = try await store.taskReviewGuideStatus(taskID, url: url)
                    guard !Task.isCancelled, generation == owner, identity == scope, response?.run?.active == true else { return }
                    if status.run?.id != response?.run?.id || status.run?.active != true { response?.run = status.run; await load() }
                    else if let current = response?.run, let incoming = status.run, current.active, incoming.updatedAt >= current.updatedAt { response?.run = incoming }
                } catch { guard !Task.isCancelled, generation == owner, identity == scope else { return }; self.error = error.localizedDescription }
            }
        }
        .onAppear { store.presentedReviewGuideURL = url; store.reviewGuideNotices.removeAll { $0.url == url } }
        .onDisappear { owner = UUID(); if store.presentedReviewGuideURL == url { store.presentedReviewGuideURL = nil } }
        .onChange(of: store.reviewGuideHandoffOutcome?.id) { _, value in
            guard value == handoffID, let outcome = store.reviewGuideHandoffOutcome else { return }
            if let message = outcome.error { error = message } else { notice = "已加入输入框，请检查后发送" }
        }
    }
    private func tourContent(showMenu: Bool) -> some View {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Color.clear.frame(height: 1).id("top")
                        if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
                        if let notice { Text(fridayString: notice).font(.caption).foregroundStyle(.secondary) }
                        if let head = response?.guide?.headSha, head != detail.headSha, response?.stale != true { Text(friday: "请求版本已改变，请刷新后添加批注").font(.caption).foregroundStyle(.secondary) }
                        if response?.stale == true { Text(friday: "此 Guide 生成于最新推送之前，摘录仍对应原版本。请重写后再添加行评论。").font(.caption).foregroundStyle(.orange) }
                        if let run = response?.run, run.headSha == response?.currentHeadSha, !run.active, run.status != "completed", let message = run.error { Text(fridayString: message).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
                        if let guide = response?.guide {
                            if guide.stops.isEmpty { Text(friday: "这次变更没有可导览的文件").foregroundStyle(.secondary) }
                            else {
                                if showMenu { stopRail(guide) }
                                let index = min(max(progress.position, 0), guide.stops.count - 1)
                                stop(guide.stops[index], index: index, guide: guide)
                                HStack {
                                    Button(friday: "上一站", systemImage: "chevron.left") { move(index - 1, guide: guide) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(index == 0)
                                    Spacer()
                                    if index + 1 < guide.stops.count { Button(friday: "下一站", systemImage: "chevron.right") { move(index + 1, guide: guide) }.buttonStyle(FridayButtonStyle(compact: true)) }
                                    else { Button(friday: "完成导览并审查", systemImage: "checkmark.circle") { progress.seen.insert(index); saveProgress(guide); finishReview() }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)) }
                                }
                            }
                        } else if loading { Text(friday: "正在读取 Guide…").foregroundStyle(.secondary) }
                        else { Text(friday: response?.run?.active == true ? "模型正在阅读变更，可以关闭窗口，生成会继续。" : "尚未生成 Guide。它会按阅读顺序讲解代码和需要维护者判断的取舍。").foregroundStyle(.secondary) }
                    }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                }.onChange(of: progress.position) { _, _ in proxy.scrollTo("top", anchor: .top) }
            }
    }
    private func rail(_ guide: TaskReviewGuide) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(Array(guide.stops.enumerated()), id: \.offset) { index, value in
                    Button { move(index, guide: guide) } label: {
                        HStack(alignment: .top, spacing: 8) {
                            FridaySymbolImage(systemName: progress.seen.contains(index) ? "checkmark.circle" : "circle").frame(width: 18)
                            Text("\(index + 1). \(value.title)").font(.callout).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
                        }.padding(8).background(progress.position == index ? Color.accentColor.opacity(0.1) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                    }.buttonStyle(FridaySymbolButtonStyle())
                }
            }.padding(10)
        }
    }
    private func stopRail(_ guide: TaskReviewGuide) -> some View {
        Menu {
            ForEach(Array(guide.stops.enumerated()), id: \.offset) { index, value in Button { move(index, guide: guide) } label: { Label("\(index + 1). \(value.title)", systemImage: progress.seen.contains(index) ? "checkmark.circle" : "circle") } }
        } label: { HStack { Text("\(min(progress.position + 1, guide.stops.count)) / \(guide.stops.count)").font(.system(.caption, design: .monospaced)); Text(guide.stops[min(max(progress.position, 0), guide.stops.count - 1)].title).fontWeight(.medium); Spacer(); FridaySymbolImage(systemName: "chevron.down") } }.fridayInteractiveCursor()
    }
    private func stop(_ value: TaskReviewGuide.Stop, index: Int, guide: TaskReviewGuide) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(index + 1). \(value.title)").font(.title3.weight(.semibold)).textSelection(.enabled)
            if !value.summary.isEmpty { AgentMarkdown(text: value.summary) }
            if let attention = value.attention { HStack(alignment: .top, spacing: 8) { FridaySymbolImage(systemName: attention.kind == "accessibility" ? "accessibility" : "lightbulb"); VStack(alignment: .leading, spacing: 6) { Text(fridayString: attentionLabel(attention.kind)).font(.caption.weight(.medium)); AgentMarkdown(text: attention.note, compact: true) } }.font(.callout).padding(12).background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8)) }
            ForEach(Array(value.excerpts.enumerated()), id: \.offset) { _, excerpt in
                if let snapshot = response?.excerpts.first(where: { $0.path == excerpt.path && $0.side == excerpt.side && $0.start == excerpt.start && $0.end == excerpt.end }) {
                    TaskGuideExcerptView(snapshot: snapshot, notes: value.notes.filter { $0.path == excerpt.path && excerpt.start <= $0.line && $0.line <= excerpt.end }, comments: pendingComments.filter { $0.headSha == guide.headSha && $0.path == snapshot.path && ($0.position.usesOldSide ? snapshot.side == "old" : snapshot.side == "new") }, canComment: canComment && response?.stale != true && guide.headSha == detail.headSha, openFile: { openFile(excerpt.path) }, ask: { handoff(index, question: "请解释 \(excerpt.path) 第 \(excerpt.start)–\(excerpt.end) 行的设计", guide: guide) }, submit: { line, body in comment(guide.headSha, snapshot, line, body) }, remove: removeComment)
                }
            }
            ForEach(Array(value.files.enumerated()), id: \.offset) { _, file in
                Button { openFile(file.path) } label: { HStack(alignment: .top) { FridaySymbolImage(systemName: "doc.text"); VStack(alignment: .leading, spacing: 4) { Text(file.path).font(.system(.caption, design: .monospaced)); if let note = file.note, !note.isEmpty { Text(note).font(.caption).foregroundStyle(.secondary) } }; Spacer(); FridaySymbolImage(systemName: "arrow.right") } }.buttonStyle(FridaySymbolButtonStyle())
            }
            ForEach(Array(value.questions.enumerated()), id: \.offset) { _, text in Button { handoff(index, question: text, guide: guide) } label: { Label { Text(text) } icon: { FridaySymbolImage(systemName: "questionmark.bubble") } }.buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected || handoffBusy) }
            Button(friday: "询问这一站", systemImage: "text.bubble") { handoff(index, question: "", guide: guide) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected || handoffBusy)
        }
    }
    private func handoff(_ index: Int, question: String, guide: TaskReviewGuide) {
        guard !handoffBusy, store.connected else { return }
        handoffBusy = true; error = nil; let generation = owner, identity = scope, connection = store.connectionIdentity
        Task { @MainActor in
            defer { if generation == owner, identity == scope { handoffBusy = false } }
            guard generation == owner, identity == scope else { return }
            do {
                let reference = try await store.captureReviewGuideContext(taskID, url: url, guide: guide, stop: index)
                guard generation == owner, identity == scope else { return }
                let value = TaskGuideComposerHandoff(identity: connection, taskID: taskID, question: question, reference: reference)
                handoffID = value.id; notice = "正在加入任务输入框…"; store.reviewGuideComposerHandoff = value
            } catch { if generation == owner, identity == scope { self.error = error.localizedDescription } }
        }
    }
    private func attentionLabel(_ kind: String) -> String {
        switch kind { case "tradeoff": return "设计取舍"; case "contract": return "公开契约"; case "product": return "产品行为"; case "risk": return "风险判断"; case "accessibility": return "无障碍"; default: return kind }
    }
    private func step(_ delta: Int) { if let guide = response?.guide { move(progress.position + delta, guide: guide) } }
    private func progressKey(_ guide: TaskReviewGuide) -> String { TaskGuideProgress.key(server: store.connection.server, serviceID: store.serviceId, url: url, head: guide.headSha) }
    private func saveProgress(_ guide: TaskReviewGuide) { if let data = try? JSONEncoder().encode(progress) { UserDefaults.standard.set(data, forKey: progressKey(guide)) } }
    private func move(_ index: Int, guide: TaskReviewGuide) { progress.move(to: index, count: guide.stops.count); saveProgress(guide) }
    @MainActor private func load() async {
        let generation = owner, identity = scope, token = UUID(); loadToken = token; loading = true
        defer { if owner == generation, scope == identity, loadToken == token { loading = false } }
        do {
            let value = try await store.taskReviewGuide(taskID, url: url)
            guard !Task.isCancelled, generation == owner, identity == scope, token == loadToken else { return }
            if let held = response, !held.accepts(value) { return }
            if response?.run?.active == true, value.run?.status == "completed" { notice = "Guide 已就绪"; refreshDetail() }
            response = value; self.error = nil
            if let guide = value.guide, loadedProgress != progressKey(guide) { loadedProgress = progressKey(guide); progress = UserDefaults.standard.data(forKey: loadedProgress).flatMap { try? JSONDecoder().decode(TaskGuideProgress.self, from: $0) } ?? TaskGuideProgress(); progress.move(to: progress.position, count: guide.stops.count) }
        } catch { if !Task.isCancelled, generation == owner, identity == scope, token == loadToken { self.error = error.localizedDescription } }
    }
    private func generate() {
        guard !sending, store.connected else { return }
        if request == nil { request = (UUID().uuidString, response?.currentHeadSha ?? detail.headSha) }
        guard let pending = request else { return }; sending = true; error = nil
        let generation = owner, identity = scope
        Task { @MainActor in
            defer { if generation == owner, identity == scope { sending = false } }
            guard generation == owner, identity == scope else { return }
            do { _ = try await store.generateTaskReviewGuide(taskID, url: url, head: pending.head, requestID: pending.id); guard generation == owner, identity == scope else { return }; request = nil; await load() }
            catch { guard generation == owner, identity == scope else { return }; if error is TaskChangeRequestRejection { request = nil }; self.error = error.localizedDescription }
        }
    }
    private func cancel(_ id: String) {
        sending = true; let generation = owner, identity = scope
        Task { @MainActor in defer { if generation == owner, identity == scope { sending = false } }; guard generation == owner, identity == scope else { return }; do { try await store.cancelTaskReviewGuide(taskID, url: url, runID: id); if generation == owner, identity == scope { await load() } } catch { if generation == owner, identity == scope { self.error = error.localizedDescription } } }
    }
}
