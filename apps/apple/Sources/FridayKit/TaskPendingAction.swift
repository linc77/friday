import SwiftUI

struct TaskPendingAction: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let approval: Approval
    let stop: () -> Void
    @State private var draft = TaskQuestionDraft()
    @State private var busy = false
    @State private var error: String?
    @State private var expanded = true
    @State private var advanceToken: String?
    @State private var responseRequestID = UUID().uuidString

    private var question: Question? {
        guard !approval.questions.isEmpty else { return nil }
        return approval.questions[max(0, min(draft.index, approval.questions.count - 1))]
    }
    private var last: Bool { draft.index >= approval.questions.count - 1 }
    private var disabled: Bool { busy || !store.connected || !approval.canRespond }
    private var cacheKey: String { "question:\(task.id):\(approval.id)" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 9) {
                    FridaySymbolImage(systemName: question == nil ? "hand.raised" : "questionmark.circle")
                    Text(question?.header.isEmpty == false ? question!.header : approval.title).fontWeight(.medium).lineLimit(1)
                    Spacer(minLength: 4)
                    if !approval.questions.isEmpty { Text("\(draft.index + 1)/\(approval.questions.count)").monospacedDigit() }
                    else {
                        let count = task.approvals.filter { $0.state == "pending" }.count
                        if count > 1 { Text("1/\(count)").monospacedDigit() }
                    }
                    FridaySymbolImage(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 10))
                }.font(.caption).foregroundStyle(.secondary).contentShape(Rectangle())
            }.buttonStyle(FridaySymbolButtonStyle()).accessibilityValue(Text(friday: expanded ? "已展开" : "已收起"))
            if expanded {
                if let question { questionContent(question) }
                else {
                    ScrollView {
                        Text(verbatim: approval.detail).font(.system(.caption, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }.frame(maxHeight: 160)
                    ForEach(Array(Set(approval.effectiveOptions.compactMap(\.warning))).sorted(), id: \.self) { warning in
                        Text(verbatim: warning).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                    }
                }
            }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            if approval.responseStatus == "uncertain" { Text(friday: "回应结果尚未确认；请核对执行记录或停止任务，不会自动重复授权。").font(.caption).foregroundStyle(.orange) }
            if let appName = approval.appName, !appName.isEmpty { Text(verbatim: appName).font(.caption).foregroundStyle(.secondary) }
            HStack(spacing: 8) {
                Button(action: stop) {
                    FridaySymbolImage(systemName: "stop.fill").font(.system(size: 8, weight: .medium))
                }.buttonStyle(AgentTaskActionButtonStyle(destructive: true)).accessibilityLabel(Text(friday: "停止")).disabled(busy || !store.connected || !(task.active || store.taskBackgroundSettlementSupported && task.backgroundStopAvailable))
                Spacer(minLength: 4)
                if question != nil {
                    if draft.index > 0 {
                        Button(friday: "上一题") { advanceToken = nil; draft.index -= 1 }
                            .buttonStyle(FridayButtonStyle(compact: true)).disabled(disabled)
                    }
                    Button(friday: last ? "提交回答" : "下一题") {
                        advanceToken = nil
                        if last { respond("accept") } else { draft.index += 1 }
                    }.buttonStyle(FridayButtonStyle(prominent: true, compact: true))
                        .disabled(disabled || (last ? !draft.complete(approval.questions) : question.map { draft.answers(for: $0).isEmpty } != false))
                } else {
                    ForEach(approval.effectiveOptions.filter { ["accept", "decline"].contains($0.decision) }) { option in
                        Button(friday: approval.label(option)) { respond(option.decision) }.buttonStyle(FridayButtonStyle(prominent: option.decision == "accept", compact: true)).disabled(disabled).accessibilityHint(Text(verbatim: option.warning ?? ""))
                    }
                    if approval.effectiveOptions.contains(where: { !["accept", "decline"].contains($0.decision) }) {
                        Menu {
                            ForEach(approval.effectiveOptions.filter { !["accept", "decline"].contains($0.decision) }) { option in
                                Button(friday: approval.label(option)) { respond(option.decision) }.accessibilityHint(Text(verbatim: option.warning ?? ""))
                            }
                        } label: { FridaySymbolImage(systemName: "ellipsis").frame(width: 24, height: 24) }.buttonStyle(FridaySymbolButtonStyle()).fridayInteractiveCursor().disabled(disabled).accessibilityLabel(Text(friday: "更多授权选项"))
                    }
                }
            }
        }
        .onAppear {
            if let saved = TaskDraftCache.load(TaskQuestionDraft.self, server: store.connection.server, context: cacheKey) { draft = saved }
            draft.index = max(0, min(draft.index, max(0, approval.questions.count - 1)))
        }
        .onChange(of: draft) { _, value in
            TaskDraftCache.save(value.safeToCache(approval.questions), server: store.connection.server, context: cacheKey)
        }
        .task(id: advanceToken) {
            guard let token = advanceToken else { return }
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
            guard !Task.isCancelled, token == advanceToken, !last, !disabled else { return }
            draft.index += 1; advanceToken = nil
        }
    }

    private func questionContent(_ question: Question) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            AgentMarkdown(text: question.question, compact: true)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                        let selected = draft.custom[question.id]?.isEmpty != false && (draft.selected[question.id] ?? []).contains(option.answerValue)
                        Button {
                            draft.toggle(option.answerValue, for: question)
                            advanceToken = question.multiSelect == true ? nil : "\(question.id):\(option.answerValue)"
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Text("\(index + 1)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                    .frame(width: 18).padding(.top, 1)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(option.label).font(.callout)
                                    if !option.description.isEmpty { Text(option.description).font(.caption).foregroundStyle(.secondary) }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                FridaySymbolImage(systemName: selected ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selected ? FridayTheme.accent : .secondary).font(.callout)
                            }.padding(10).contentShape(RoundedRectangle(cornerRadius: 9))
                                .background(selected ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 9))
                        }.buttonStyle(FridaySymbolButtonStyle()).disabled(disabled)
                            .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
            }.scrollBounceBehavior(.basedOnSize).frame(maxHeight: 240)
            if question.isOther != false || question.options.isEmpty {
                let text = Binding(get: { draft.custom[question.id] ?? "" }, set: { draft.custom[question.id] = $0; advanceToken = nil })
                if question.isSecret == true {
                    SecureField(friday: "你的回答", text: text).textFieldStyle(.roundedBorder).disabled(disabled)
                } else {
                    TextField(friday: "你的回答", text: text, axis: .vertical).lineLimit(1...4)
                        .textFieldStyle(.roundedBorder).disabled(disabled)
                }
            }
        }
    }

    private func respond(_ decision: String) {
        guard !disabled else { return }
        busy = true; error = nil
        let answers = Dictionary(uniqueKeysWithValues: approval.questions.map { ($0.id, draft.answers(for: $0)) })
        let connection = store.connection, identity = store.connectionIdentity, server = connection.server, context = cacheKey
        Task { @MainActor in
            defer { busy = false }
            do {
                _ = try await connection.data("/api/tasks/\(task.id)/approvals/\(approval.id)", method: "POST", body: ["decision": decision, "answers": answers, "requestId": responseRequestID])
                TaskDraftCache.save(Optional<TaskQuestionDraft>.none, server: server, context: context)
                guard identity == store.connectionIdentity else { return }
                await store.refresh()
            } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } }
        }
    }
}
