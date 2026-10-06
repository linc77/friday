import SwiftUI

struct TaskDetail: View {
    @ObservedObject var store: FridayStore
    let id: String
    @State private var message = ""
    @State private var messageId = UUID().uuidString
    @State private var showEvents = false
    @State private var sending = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var task: WorkItem? { store.tasks.first { $0.id == id } }

    var body: some View {
        if let task {
            VStack(spacing: 0) {
                header(task)
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        requestCard(task)
                        ForEach(task.approvals.filter { $0.state == "pending" }) { approval in
                            ApprovalCard(store: store, taskId: id, approval: approval)
                                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
                        }
                        if let error = task.error {
                            Label(error, systemImage: "exclamationmark.circle")
                                .font(.callout).foregroundStyle(.orange).textSelection(.enabled)
                                .padding(18).frame(maxWidth: .infinity, alignment: .leading).fridayCard()
                        }
                        if task.active { progressCard(task) }
                        if !task.result.isEmpty { resultCard(task) }
                        executionHistory(task)
                    }
                    // Animate only approval insertion/removal, never the streamed result.
                    .animation(reduceMotion ? nil : FridayTheme.motion, value: task.approvals.filter { $0.state == "pending" }.map(\.id))
                    .padding(24).frame(maxWidth: FridayTheme.contentWidth + 48).frame(maxWidth: .infinity)
                }
            }
            .background(FridayTheme.canvas)
            #if os(iOS)
            .navigationTitle("任务详情")
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom, spacing: 0) {
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
            .onChange(of: id) { _, _ in
                message = ""; messageId = UUID().uuidString; showEvents = false
            }
        } else {
            EmptyPanel(icon: "checklist", title: "正在加载任务", subtitle: "连接主机后会显示最新进展。")
        }
    }

    private func header(_ task: WorkItem) -> some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 10) {
                Text(task.title).font(.title3.weight(.semibold)).lineLimit(3).textSelection(.enabled)
                HStack(spacing: 10) {
                    StatusBadge(task: task)
                    Text(task.mode == "research" ? "调研与整理" : "代码任务")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if task.active {
                Button("停止", systemImage: "stop", role: .destructive) {
                    Task { _ = await store.perform("/api/tasks/\(id)/cancel") }
                }
                .buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected)
            }
        }
        .padding(.horizontal, 26).padding(.top, 24).padding(.bottom, 10)
    }

    private func requestCard(_ task: WorkItem) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("你的任务", systemImage: "text.bubble")
                .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            Text(task.prompt).font(.body).lineSpacing(5).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }.padding(22).fridayCard()
    }

    private func progressCard(_ task: WorkItem) -> some View {
        HStack(alignment: .center, spacing: 14) {
            FridayTaskStatusIcon(status: task.status)
                .font(.system(size: 20, weight: .light))
                .foregroundStyle(task.status == "waiting" ? .orange : FridayTheme.accent)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 5) {
                Text(task.status == "queued" ? "已加入队列" : task.status == "waiting" ? "需要你的确认" : "Friday 正在处理")
                    .font(.callout.weight(.medium))
                Text(task.status == "queued" ? "前面的任务完成后开始。" : task.status == "waiting" ? "处理上方请求后，任务会继续推进。" : "你可以继续补充要求，关闭窗口也不影响执行。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .background(FridayTheme.accent.opacity(0.055), in: RoundedRectangle(cornerRadius: 16))
    }

    private func resultCard(_ task: WorkItem) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 9) {
                FridayMark(size: 30)
                Text("Friday").font(.subheadline.weight(.semibold))
                Spacer()
                if task.artifact != nil {
                    Label("已保存", systemImage: "checkmark.circle")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(.init(task.result)).font(.body).lineSpacing(6)
                .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            if task.artifact != nil {
                HStack(spacing: 12) {
                    Image(systemName: "doc.text").font(.title3).foregroundStyle(FridayTheme.accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("任务成果").font(.callout.weight(.medium))
                        Text("已保存在主机，可随时导出").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    ShareLink(item: task.result) { Image(systemName: "square.and.arrow.up").accessibilityLabel("导出结果") }
                        .buttonStyle(FridayButtonStyle(compact: true)).help("导出结果")
                }
                .padding(14).background(FridayTheme.accent.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
            }
        }.padding(24).fridayCard()
    }

    private func executionHistory(_ task: WorkItem) -> some View {
        DisclosureGroup(isExpanded: $showEvents) {
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(task.events) { event in
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "circle.fill").font(.system(size: 5))
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
                if let thread = task.threadId {
                    Text("会话 \(thread)").font(.caption2.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
                }
            }.padding(.top, 16)
        } label: {
            HStack {
                Label("执行记录", systemImage: "clock.arrow.circlepath")
                Spacer()
                Text("\(task.events.count)").monospacedDigit()
            }.font(.caption).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4)
        .animation(reduceMotion ? nil : FridayTheme.motion, value: showEvents)
    }

    private func sendMessage() {
        let taskId = id
        let submittedMessage = message
        let requestId = messageId
        sending = true
        Task {
            if await store.perform("/api/tasks/\(taskId)/message", body: ["text": submittedMessage, "requestId": requestId]) {
                if message == submittedMessage { message = "" }
                messageId = UUID().uuidString
            }
            sending = false
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
            TextField(active ? "补充要求，或告诉 Friday 更多背景…" : "基于这个结果，接着做什么？", text: $message, axis: .vertical)
                .font(.body).lineLimit(2...5).textFieldStyle(.plain)
                .focused($focused).accessibilityLabel("补充要求")
            HStack(spacing: 12) {
                if let error {
                    Text(error).font(.caption).foregroundStyle(.orange).lineLimit(2)
                } else {
                    #if os(macOS)
                    Text("⌘ ↵ 发送").font(.caption2).foregroundStyle(.tertiary)
                    #endif
                }
                Spacer(minLength: 0)
                Button(action: send) {
                    Label(sending ? "发送中" : active ? "发送补充" : "继续任务", systemImage: "arrow.up")
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
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                    .frame(width: 34, height: 34).background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                Text(approval.title).font(.headline)
            }
            Text(approval.detail).font(.callout).lineSpacing(4).textSelection(.enabled)
            ForEach(approval.questions) { question in
                VStack(alignment: .leading, spacing: 10) {
                    Text(question.question).font(.callout.weight(.medium))
                    ForEach(question.options, id: \.label) { option in
                        Button { answers[question.id] = option.label } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: answers[question.id] == option.label ? "checkmark.circle.fill" : "circle")
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(option.label)
                                    if !option.description.isEmpty { Text(option.description).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer(minLength: 0)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(FridayButtonStyle())
                    }
                    TextField("你的回答", text: Binding(get: { answers[question.id] ?? "" }, set: { answers[question.id] = $0 }))
                        .textFieldStyle(.roundedBorder)
                }
            }
            HStack {
                Spacer()
                if approval.questions.isEmpty { Button("拒绝") { respond("decline") }.buttonStyle(FridayButtonStyle()) }
                Button(approval.questions.isEmpty ? "允许本次" : "提交回答") { respond("accept") }
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
