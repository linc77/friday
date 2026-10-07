import SwiftUI

struct TaskDetail: View {
    @ObservedObject var store: FridayStore
    let id: String
    var onOpenTask: ((String) -> Void)? = nil
    @State private var message = ""
    @State private var messageId = UUID().uuidString
    @State private var showEvents = false
    @State private var sending = false
    @State private var followingEnd = true
    @State private var atEnd = true
    @State private var previousScrollTop: CGFloat?
    @State private var scrollRequest = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var task: WorkItem? { store.tasks.first { $0.id == id } }

    var body: some View {
        if let task {
            VStack(spacing: 0) {
                header(task)
                transcriptScroll(task)
            }
            .background(FridayTheme.canvas)
            #if os(iOS)
            .navigationTitle("Friday")
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if task.localAgent {
                    AgentTaskComposer(store: store, task: task, message: $message, sending: sending, send: sendAgentMessage)
                        .frame(maxWidth: FridayTheme.contentWidth).padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 16).frame(maxWidth: .infinity)
                } else {
                    FloatingComposer(
                        message: $message,
                        active: task.active,
                        sending: sending,
                        disabled: sending || !store.connected || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || task.status == "queued",
                        error: store.error,
                        send: sendMessage
                    )
                    .frame(maxWidth: FridayTheme.contentWidth)
                    .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 20)
                    .frame(maxWidth: .infinity)
                }
            }
            .onChange(of: id) { _, _ in
                message = ""; messageId = UUID().uuidString; showEvents = false
                followingEnd = true; atEnd = true; previousScrollTop = nil
            }
        } else {
            EmptyPanel(icon: "checklist", title: "正在加载任务", subtitle: "连接主机后会显示最新进展。")
        }
    }

    private func transcriptScroll(_ task: WorkItem) -> some View {
        ScrollViewReader { proxy in
            GeometryReader { viewport in
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if task.localAgent {
                            CodexTimeline(task: task, canOpenLocalFiles: store.deviceId == "owner")
                        } else {
                            executionHistory(task)
                            ForEach(task.conversation) { message in conversationMessage(message, task: task) }
                        }
                        delegatedTasks(task)
                        if task.status == "needs_project" { WorkspaceChoice(store: store, task: task).id(task.durableId) }
                        ForEach(task.approvals.filter { $0.state == "pending" }) { approval in
                            ApprovalCard(store: store, taskId: id, approval: approval)
                                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
                        }
                        if let error = task.error {
                            FridaySymbolLabel(friday: error, systemImage: "exclamationmark.circle")
                                .fridaySymbolFeedback()
                                .font(.callout).foregroundStyle(.orange).textSelection(.enabled)
                                .padding(18).frame(maxWidth: .infinity, alignment: .leading).fridayCard()
                        }
                        if task.active { progressCard(task) }
                        if task.artifact != nil && !task.localAgent { artifactCard(task) }
                        Color.clear.frame(height: 1).id("transcript-end")
                    }
                    // Animate only approval insertion/removal, never the streamed result.
                    .animation(reduceMotion ? nil : FridayTheme.motion, value: task.approvals.filter { $0.state == "pending" }.map(\.id))
                    .padding(24).frame(maxWidth: FridayTheme.contentWidth + 48).frame(maxWidth: .infinity)
                    .background(GeometryReader { geometry in
                        let frame = geometry.frame(in: .named("task-transcript"))
                        Color.clear.preference(key: TranscriptScrollKey.self, value: TranscriptScrollMetrics(top: frame.minY, bottom: frame.maxY, viewportHeight: viewport.size.height))
                    })
                }
                .coordinateSpace(name: "task-transcript")
                .modifier(TranscriptScrollObserver { metrics in
                    guard metrics.bottom > 0 else { return }
                    if let previousScrollTop, metrics.top > previousScrollTop + 3 { followingEnd = false }
                    previousScrollTop = metrics.top
                    atEnd = metrics.bottom <= metrics.viewportHeight + 48
                    if atEnd { followingEnd = true }
                })
                .overlay(alignment: .bottom) {
                    if !atEnd {
                        Button {
                            followingEnd = true
                            withAnimation(reduceMotion ? nil : FridayTheme.motion) { proxy.scrollTo("transcript-end", anchor: .bottom) }
                        } label: { FridaySymbolLabel(friday: "回到最新", systemImage: "arrow.down") }
                            .buttonStyle(FridayButtonStyle(compact: true)).font(.caption).padding(.bottom, 10)
                    }
                }
                .task(id: id) {
                    await Task.yield()
                    proxy.scrollTo("transcript-end", anchor: .bottom)
                }
                .task(id: task.updatedAt) {
                    await Task.yield()
                    if followingEnd { proxy.scrollTo("transcript-end", anchor: .bottom) }
                }
                .onChange(of: scrollRequest) { _, _ in proxy.scrollTo("transcript-end", anchor: .bottom) }
            }
        }
    }

    private func header(_ task: WorkItem) -> some View {
        HStack(alignment: task.localAgent ? .center : .top, spacing: 14) {
            if task.localAgent {
                Text(store.projects.first { $0.id == task.projectId }?.name ?? "Codex")
                    .font(.callout).foregroundStyle(.secondary).lineLimit(1)
                Text("/").foregroundStyle(.tertiary)
                Text(task.title).font(.callout.weight(.medium)).lineLimit(1).textSelection(.enabled)
                Spacer(minLength: 8)
                StatusBadge(task: task)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Friday").font(.caption).foregroundStyle(.secondary)
                    Text(task.title).font(.title3.weight(.semibold)).lineLimit(3).textSelection(.enabled)
                    StatusBadge(task: task)
                }
                Spacer(minLength: 8)
            }
            if task.active || task.status == "needs_project" {
                Button(friday: "停止", systemImage: "stop", role: .destructive) {
                    Task { _ = await store.perform("/api/tasks/\(id)/cancel") }
                }
                .buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected)
            }
        }
        .padding(.horizontal, 26).padding(.top, 24).padding(.bottom, 10)
    }

    @ViewBuilder private func conversationMessage(_ message: ChatMessage, task: WorkItem) -> some View {
        if message.role == "user" {
            HStack {
                Spacer(minLength: 36)
                Text(message.text).font(.body).lineSpacing(5).textSelection(.enabled)
                    .padding(18)
                    .background(FridayTheme.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
            }
        } else {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 9) {
                    if task.localAgent {
                        FridaySymbolImage(systemName: "terminal").fridaySymbolFeedback().font(.subheadline).foregroundStyle(.secondary)
                    } else { FridayMark(size: 30) }
                    Text(task.agentName).font(.subheadline.weight(.semibold))
                }
                Text(.init(message.text)).font(.body).lineSpacing(6)
                    .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }.padding(task.localAgent ? 4 : 24).background(task.localAgent ? Color.clear : FridayTheme.surface, in: RoundedRectangle(cornerRadius: FridayTheme.cornerRadius))
        }
    }

    private func progressCard(_ task: WorkItem) -> some View {
        HStack(alignment: .center, spacing: 14) {
            FridayTaskStatusIcon(status: task.status)
                .font(.system(size: 20, weight: .light))
                .foregroundStyle(task.status == "waiting" ? .orange : FridayTheme.accent)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 5) {
                Text(fridayString: task.status == "queued" ? "已加入队列" : task.status == "waiting" ? "需要你的确认" : task.localAgent ? "Codex 正在执行" : "Friday 正在处理")
                    .font(.callout.weight(.medium))
                Text(fridayString: task.status == "queued" ? "前面的任务完成后开始。" : task.status == "waiting" ? "处理上方请求后，任务会继续推进。" : "你可以继续补充要求，关闭窗口也不影响执行。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .background(FridayTheme.accent.opacity(0.055), in: RoundedRectangle(cornerRadius: 16))
    }

    private func artifactCard(_ task: WorkItem) -> some View {
        HStack(spacing: 12) {
            FridaySymbolImage(systemName: "doc.text").font(.title3).foregroundStyle(FridayTheme.accent).fridaySymbolFeedback()
            VStack(alignment: .leading, spacing: 3) {
                Text(friday: "任务成果").font(.callout.weight(.medium))
                Text(friday: "已保存在主机，可随时导出").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            ShareLink(item: task.result) { FridaySymbolImage(systemName: "square.and.arrow.up").accessibilityLabel(Text(friday: "导出结果")) }
                .buttonStyle(FridayButtonStyle(compact: true)).help(Text(friday: "导出结果"))
        }
        .padding(18).fridayCard()
    }

    private func executionHistory(_ task: WorkItem) -> some View {
        DisclosureGroup(isExpanded: $showEvents) {
            LazyVStack(alignment: .leading, spacing: 18) {
                Text(friday: "执行工具：\(task.agent.capitalized)").font(.caption).foregroundStyle(.secondary)
                if task.projectId != nil {
                    Text(friday: "工作目录：\(task.cwd)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                if let thread = task.threadId {
                    Text(friday: "会话 \(thread)").font(.caption2.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
                }
                ForEach(task.events) { event in
                    HStack(alignment: .top, spacing: 12) {
                        FridaySymbolImage(systemName: "circle.fill").font(.system(size: 5))
                            .foregroundStyle(.tertiary).padding(.top, 5).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(event.at.dropFirst(11).prefix(8)) · \(event.kind)")
                                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                            Text(event.text)
                                .font(.system(.caption, design: event.kind == "command" || event.kind == "files" ? .monospaced : .default))
                                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }.padding(.top, 16)
        } label: {
            HStack {
                FridaySymbolLabel(friday: "执行详情", systemImage: "clock.arrow.circlepath")
                    .fridaySymbolFeedback(value: showEvents)
                Spacer()
                Text("\(task.events.count)").monospacedDigit()
            }.font(.caption).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4)
        .animation(reduceMotion ? nil : FridayTheme.motion, value: showEvents)
    }

    @ViewBuilder private func delegatedTasks(_ task: WorkItem) -> some View {
        ForEach(store.tasks.filter { $0.parentId == task.id }) { child in
            Button { onOpenTask?(child.id) } label: {
                HStack(spacing: 12) {
                    FridaySymbolImage(systemName: "terminal").fridaySymbolFeedback()
                    VStack(alignment: .leading, spacing: 4) {
                        Text(child.title).lineLimit(2)
                        Text(child.agentName).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusBadge(task: child)
                    FridaySymbolImage(systemName: "chevron.right").fridaySymbolFeedback()
                }.padding(16)
            }.buttonStyle(FridayButtonStyle()).accessibilityLabel(Text(friday: "打开任务"))
        }
    }

    private func sendAgentMessage(_ model: String, _ effort: String) {
        sendMessage(model: model, effort: effort)
    }

    private func sendMessage() { sendMessage(model: nil, effort: nil) }

    private func sendMessage(model: String?, effort: String?) {
        let taskId = id
        let submittedMessage = message
        let requestId = messageId
        sending = true
        var body: [String: Any] = ["text": submittedMessage, "requestId": requestId]
        if task?.active != true {
            if let model { body["model"] = model }; if let effort { body["reasoningEffort"] = effort }
        }
        Task {
            if await store.perform("/api/tasks/\(taskId)/message", body: body) {
                if message == submittedMessage { message = "" }
                messageId = UUID().uuidString
                followingEnd = true; scrollRequest += 1
            }
            sending = false
        }
    }
}

private struct TranscriptScrollMetrics: Equatable { var top: CGFloat = 0; var bottom: CGFloat = 0; var viewportHeight: CGFloat = 0 }
private struct TranscriptScrollKey: PreferenceKey {
    static let defaultValue = TranscriptScrollMetrics()
    static func reduce(value: inout TranscriptScrollMetrics, nextValue: () -> TranscriptScrollMetrics) { value = nextValue() }
}

private struct TranscriptScrollObserver: ViewModifier {
    let changed: (TranscriptScrollMetrics) -> Void
    @ViewBuilder func body(content: Content) -> some View {
        if #available(macOS 15.0, iOS 18.0, *) {
            content.onScrollGeometryChange(for: TranscriptScrollMetrics.self) { geometry in
                TranscriptScrollMetrics(top: -geometry.contentOffset.y, bottom: geometry.contentSize.height - geometry.contentOffset.y, viewportHeight: geometry.containerSize.height)
            } action: { _, metrics in changed(metrics) }
        } else {
            content.onPreferenceChange(TranscriptScrollKey.self, perform: changed)
        }
    }
}

private struct FloatingComposer: View {
    @Binding var message: String
    let active: Bool
    let sending: Bool
    let disabled: Bool
    let error: String?
    let send: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            TextField(friday: active ? "补充要求，或告诉 Friday 更多背景…" : "基于这个结果，接着做什么？", text: $message, axis: .vertical)
                .font(.body).lineLimit(2...5).textFieldStyle(.plain)
                .focused($focused).accessibilityLabel(Text(friday: "补充要求"))
                .onChatSubmit { if !disabled { send() } }
            HStack(spacing: 12) {
                if let error {
                    Text(fridayString: error).font(.caption).foregroundStyle(.orange).lineLimit(2)
                }
                Spacer(minLength: 0)
                Button(action: send) {
                    FridaySymbolLabel(friday: sending ? "发送中" : "发送", systemImage: "arrow.up")
                }
                .buttonStyle(FridayButtonStyle(prominent: true, compact: true))
                .keyboardShortcut(.return, modifiers: .command).disabled(disabled)
            }
        }
        .padding(18).fridayFloatingSurface()
        .overlay {
            RoundedRectangle(cornerRadius: FridayTheme.cornerRadius)
                .strokeBorder(FridayTheme.accent.opacity(focused ? 0.35 : 0), lineWidth: 1)
                .allowsHitTesting(false)
        }
    }
}

struct ApprovalCard: View {
    @ObservedObject var store: FridayStore
    let taskId: String
    let approval: Approval
    @State private var answers: [String: String] = [:]
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                FridaySymbolImage(systemName: "hand.raised.fill").foregroundStyle(.orange)
                    .frame(width: 34, height: 34).background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                    .fridaySymbolFeedback()
                Text(approval.title).font(.headline)
            }
            Text(approval.detail).font(.callout).lineSpacing(4).textSelection(.enabled)
            ForEach(approval.questions) { question in
                VStack(alignment: .leading, spacing: 10) {
                    Text(question.question).font(.callout.weight(.medium))
                    ForEach(question.options, id: \.label) { option in
                        Button { answers[question.id] = option.label } label: {
                            HStack(alignment: .top, spacing: 8) {
                                FridaySymbolImage(systemName: answers[question.id] == option.label ? "checkmark.circle.fill" : "circle")
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(option.label)
                                    if !option.description.isEmpty { Text(option.description).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer(minLength: 0)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(FridayButtonStyle())
                    }
                    TextField(friday: "你的回答", text: Binding(get: { answers[question.id] ?? "" }, set: { answers[question.id] = $0 }))
                        .textFieldStyle(.roundedBorder)
                }
            }
            HStack {
                Spacer()
                if approval.questions.isEmpty { Button(friday: "拒绝") { respond("decline") }.buttonStyle(FridayButtonStyle()) }
                Button(friday: approval.questions.isEmpty ? "允许本次" : "提交回答") { respond("accept") }
                    .buttonStyle(FridayButtonStyle(prominent: true))
            }
        }
        .padding(22).fridayCard()
        .overlay(RoundedRectangle(cornerRadius: FridayTheme.cornerRadius).strokeBorder(.orange.opacity(0.35)))
        .disabled(busy || !store.connected)
    }

    private func respond(_ decision: String) {
        busy = true
        Task {
            _ = await store.perform("/api/tasks/\(taskId)/approvals/\(approval.id)", body: ["decision": decision, "answers": answers.mapValues { [$0] }])
            busy = false
        }
    }
}
