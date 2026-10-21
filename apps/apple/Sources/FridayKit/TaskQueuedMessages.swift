import SwiftUI
import UniformTypeIdentifiers

struct TaskQueuedMessages: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    var editingId: String? = nil
    let edit: (QueuedTaskMessage) -> Void
    let resume: () -> Void
    @State private var expanded = true
    @State private var busyId: String?
    @State private var error: String?
    @State private var preview: QueuedTaskMessage?

    private var messages: [QueuedTaskMessage] { task.queue?.pending ?? [] }
    private var disabled: Bool { busyId != nil || !store.connected }

    var body: some View {
        if !messages.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Button { expanded.toggle() } label: {
                        HStack(spacing: 8) {
                            FridaySymbolImage(systemName: "list.number")
                            Text(friday: "排队消息")
                            Text("\(messages.count)").monospacedDigit()
                            Spacer(minLength: 4)
                            FridaySymbolImage(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 9))
                        }.contentShape(Rectangle())
                    }.buttonStyle(FridaySymbolButtonStyle())
                        .accessibilityValue(Text(friday: expanded ? "已展开" : "已收起"))
                    if task.queue?.paused == true {
                        Button(action: resume) {
                            FridaySymbolLabel(friday: "继续队列", systemImage: "play.fill")
                        }.buttonStyle(FridaySymbolButtonStyle()).disabled(task.active || task.preparationFailure != nil || disabled)
                    }
                }.font(.caption).foregroundStyle(.secondary)
                if expanded {
                    ScrollView {
                        VStack(spacing: 3) { ForEach(messages) { message in row(message) } }
                    }.scrollBounceBehavior(.basedOnSize).frame(maxHeight: 128)
                }
                if let error = error ?? task.queue?.error {
                    Text(fridayString: error).font(.caption).foregroundStyle(.orange).lineLimit(3)
                }
            }
            .sheet(item: $preview) { message in
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text(friday: "排队消息").font(.headline)
                        Spacer()
                        Button { preview = nil } label: { FridaySymbolImage(systemName: "xmark").frame(width: 28, height: 28) }
                            .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "关闭"))
                    }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if !message.text.isEmpty { TaskContextMessageText(store: store, text: message.text, contexts: message.contexts ?? [], taskID: task.id) }
                            if !message.images.isEmpty { TaskImageRail(store: store, images: message.images) }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.scrollBounceBehavior(.basedOnSize).frame(maxHeight: 420)
                }.padding(24).frame(minWidth: 300, maxWidth: 560)
            }
        }
    }

    private func row(_ message: QueuedTaskMessage) -> some View {
        HStack(spacing: 8) {
            if message.editable { grip(message) }
            else { ProgressView().controlSize(.mini).frame(width: 20) }
            if let image = message.images.first {
                Button { preview = message } label: {
                    IdeaImageView(store: store, image: image, thumbnail: true)
                        .frame(width: 28, height: 28).clipped().clipShape(RoundedRectangle(cornerRadius: 4))
                }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "预览图片"))
            }
            Button { if message.editable { edit(message) } else { preview = message } } label: {
                Text(message.text.isEmpty ? message.images.map(\.name).joined(separator: " · ") : TaskContextDocument.plain(message.text))
                    .lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }.buttonStyle(FridaySymbolButtonStyle()).disabled(disabled)
            if message.editable {
                Button { edit(message) } label: { FridaySymbolImage(systemName: "pencil").frame(width: 22, height: 24) }
                    .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "编辑排队消息"))
                Button { perform(message.id, path: "/promote") } label: {
                    FridaySymbolImage(systemName: "arrow.turn.up.right").frame(width: 22, height: 24)
                }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "立即补充到当前执行"))
                    .disabled(!task.active || task.status == "queued" || task.canSteer == false || task.turnId == nil || (message.interactionMode ?? task.interactionMode ?? "default") != (task.interactionMode ?? "default"))
                Button { perform(message.id, method: "DELETE") } label: { FridaySymbolImage(systemName: "xmark").frame(width: 22, height: 24) }
                    .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "删除排队消息"))
            }
        }
        .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 4).padding(.vertical, 2)
        .background(editingId == message.id ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .disabled(disabled)
        .dropDestination(for: String.self) { items, _ in
            guard let value = items.first, value.hasPrefix(task.id + ":"), message.editable, !disabled else { return false }
            let id = String(value.dropFirst(task.id.count + 1))
            guard messages.contains(where: { $0.id == id && $0.editable }) else { return false }
            move(id, before: message.id); return true
        }
    }

    private func grip(_ message: QueuedTaskMessage) -> some View {
        Button {} label: { FridaySymbolImage(systemName: "line.3.horizontal").frame(width: 20, height: 24).contentShape(Rectangle()) }
            .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "调整排队顺序"))
            .onDrag {
                return NSItemProvider(object: (task.id + ":" + message.id) as NSString)
            }
            .contextMenu {
                Button(friday: "上移", systemImage: "arrow.up") { moveRelative(message.id, by: -1) }
                    .disabled(messages.first?.id == message.id)
                Button(friday: "下移", systemImage: "arrow.down") { moveRelative(message.id, by: 1) }
                    .disabled(messages.last?.id == message.id)
                Button(friday: "移到末尾") { move(message.id, before: nil) }
            }
            #if os(macOS)
            .onMoveCommand { direction in
                if direction == .up { moveRelative(message.id, by: -1) }
                if direction == .down { moveRelative(message.id, by: 1) }
            }
            #endif
    }

    private func moveRelative(_ id: String, by offset: Int) {
        let queued = messages.filter(\.editable)
        guard let index = queued.firstIndex(where: { $0.id == id }), queued.indices.contains(index + offset) else { return }
        let target = offset < 0 ? queued[index - 1].id : index + 2 < queued.count ? queued[index + 2].id : nil
        move(id, before: target)
    }
    private func move(_ id: String, before: String?) { perform(id, path: "/move", body: ["beforeId": before as Any? ?? NSNull()]) }
    private func perform(_ id: String, path: String = "", method: String = "POST", body: [String: Any] = [:]) {
        guard !disabled else { return }
        busyId = id; error = nil
        Task { @MainActor in
            defer { busyId = nil }
            do {
                _ = try await store.connection.data("/api/tasks/\(task.id)/queue/\(id)\(path)", method: method, body: method == "DELETE" ? nil : body)
                await store.refresh()
            } catch { self.error = error.localizedDescription }
        }
    }
}
