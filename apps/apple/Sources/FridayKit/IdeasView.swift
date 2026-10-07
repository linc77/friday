import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct InboxView: View {
    @ObservedObject var store: FridayStore
    let delegate: (Idea) -> Void
    @State private var selected: Idea?
    @State private var creating = false
    @State private var search = ""
    @State private var deleting: Idea?
    @AppStorage("friday.ideaDraft") private var legacyDraft = ""
    @AppStorage("friday.noteDraft.new") private var newDraft = Data()
    private var filtered: [Idea] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return store.notes.filter { query.isEmpty || $0.displayTitle.localizedStandardContains(query) || $0.text.localizedStandardContains(query) }
    }

    var body: some View {
        Group {
            if creating || selected != nil {
                IdeaDetailView(store: store, initial: selected, delegate: { idea in
                    selected = nil; creating = false; delegate(idea)
                }, close: { selected = nil; creating = false })
                .id(selected?.id ?? "new")
            } else { gallery }
        }
        .background(FridayTheme.canvas)
        .confirmationDialog(Text(friday: "删除这篇笔记？"), isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button(friday: "删除", role: .destructive) { if let idea = deleting { Task { _ = await store.deleteNote(idea); deleting = nil } } }
            Button(friday: "取消", role: .cancel) { deleting = nil }
        }
    }

    private var gallery: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack(alignment: .center, spacing: 20) {
                    PageHeading(title: "把想法放在这里", subtitle: "想法、日记和资料，都有一个自己的位置。")
                    Button { creating = true } label: { FridaySymbolLabel(friday: newDraft.isEmpty && legacyDraft.isEmpty ? "新建笔记" : "继续草稿", systemImage: "square.and.pencil") }
                        .buttonStyle(FridayButtonStyle(prominent: true)).fixedSize()
                }
                HStack(spacing: 10) {
                    FridaySymbolImage(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
                    TextField(friday: "搜索笔记", text: $search).textFieldStyle(.plain)
                    if !search.isEmpty {
                        Button { search = "" } label: { FridaySymbolImage(systemName: "xmark.circle.fill") }
                            .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "清除搜索"))
                    }
                }.padding(12).fridayCard(radius: 12).frame(maxWidth: 380)
                HStack {
                    Text(friday: "所有笔记").font(.subheadline.weight(.semibold))
                    Text("\(filtered.count)").font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                    Spacer()
                    Text(friday: "最近修改").font(.caption).foregroundStyle(.secondary)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 240, maximum: 350), spacing: 20, alignment: .top)], alignment: .leading, spacing: 20) {
                    ForEach(filtered) { idea in
                        Button { selected = idea } label: { IdeaCardView(store: store, idea: idea) }
                            .buttonStyle(FridaySymbolButtonStyle())
                            .accessibilityLabel(idea.displayTitle)
                            .accessibilityHint(Text(friday: "打开笔记，阅读或编辑内容"))
                            .contextMenu {
                                Button(friday: "打开笔记") { selected = idea }
                                Button(friday: "删除笔记", role: .destructive) { deleting = idea }
                            }
                    }
                }
                if filtered.isEmpty {
                    EmptyPanel(icon: search.isEmpty ? "scribble" : "magnifyingglass", title: search.isEmpty ? "为下一个念头留个位置" : "没有找到笔记", subtitle: search.isEmpty ? "记下今天，保存图片和链接，慢慢积累自己的资料。" : "试试标题或正文中的其他词。")
                }
            }
            .padding(28).frame(maxWidth: 1140).frame(maxWidth: .infinity)
        }
    }
}

private struct IdeaCardView: View {
    @ObservedObject var store: FridayStore
    let idea: Idea
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(idea.displayTitle).font(.title3.weight(.semibold)).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Divider().opacity(0.5)
            if let image = idea.images?.first { IdeaImageView(store: store, image: image, thumbnail: true).allowsHitTesting(false) }
            Text(idea.preview).font(.callout).foregroundStyle(.secondary).lineSpacing(4).lineLimit(idea.images?.isEmpty == false ? 3 : 8)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 4)
            HStack(spacing: 6) {
                if store.outbox.contains(where: { $0.id == idea.id }) {
                    FridaySymbolLabel(friday: "待同步", systemImage: "clock")
                } else { Text(noteDate(idea.createdAt, time: false)) }
                Spacer(minLength: 4)
                if let count = idea.images?.count, count > 0 {
                    FridaySymbolImage(systemName: "photo").accessibilityHidden(true)
                    Text("\(count)")
                }
                if idea.taskId != nil { FridaySymbolImage(systemName: FridaySymbols.chat).accessibilityLabel(Text(friday: "已交给 Friday")) }
            }.font(.caption).foregroundStyle(.tertiary)
        }
        .padding(22).frame(maxWidth: .infinity).frame(height: 310, alignment: .topLeading)
        .contentShape(RoundedRectangle(cornerRadius: FridayTheme.cornerRadius)).fridayCard()
    }
}

private struct IdeaDraft: Codable, Equatable {
    var id: String
    var title: String
    var text: String
    var images: [IdeaImage]
    var createdAt: String
    var expectedUpdatedAt: String?
    var taskId: String?
    init(_ idea: Idea?) {
        id = idea?.id ?? UUID().uuidString; title = idea?.title ?? ""; text = idea?.text ?? ""
        images = idea?.images ?? []; createdAt = idea?.createdAt ?? ISO8601DateFormatter().string(from: Date())
        text = IdeaBodyDocument.includingLegacyImages(text, images: images)
        expectedUpdatedAt = idea.map { $0.updatedAt ?? $0.createdAt }; taskId = idea?.taskId
    }
}

private struct IdeaDetailView: View {
    @ObservedObject var store: FridayStore
    let initial: Idea?
    let delegate: (Idea) -> Void
    let close: () -> Void
    @State private var draft: IdeaDraft
    @State private var baseline: IdeaDraft
    @State private var savedID: String?
    @Environment(\.scenePhase) private var scenePhase
    @State private var localError: String?
    private var draftKey: String { "friday.noteDraft." + (initial?.id ?? "new") }
    private var current: Idea? { store.notes.first { $0.id == (savedID ?? initial?.id) } ?? initial }
    private var hasContent: Bool { !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draft.images.isEmpty }
    private var hasChanges: Bool { draft.title != baseline.title || draft.text != baseline.text || draft.images != baseline.images }
    private var pending: Bool { store.outbox.contains { $0.id == current?.id } }
    private var conflicted: Bool {
        guard let id = current?.id, let version = store.outbox.first(where: { $0.id == id })?.expectedUpdatedAt,
              let remote = store.ideas.first(where: { $0.id == id }) else { return false }
        return version != (remote.updatedAt ?? remote.createdAt)
    }

    init(store: FridayStore, initial: Idea?, delegate: @escaping (Idea) -> Void, close: @escaping () -> Void) {
        self.store = store; self.initial = initial; self.delegate = delegate; self.close = close
        let key = "friday.noteDraft." + (initial?.id ?? "new")
        let recovered = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(IdeaDraft.self, from: $0) }
        var value = recovered ?? IdeaDraft(initial)
        if initial == nil, recovered == nil { value.text = UserDefaults.standard.string(forKey: "friday.ideaDraft") ?? "" }
        value.text = IdeaBodyDocument.includingLegacyImages(value.text, images: value.images)
        var original = IdeaDraft(initial)
        if initial == nil { original = value; original.title = ""; original.text = ""; original.images = [] }
        _draft = State(initialValue: value); _baseline = State(initialValue: original)
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar.padding(.horizontal, 24).padding(.vertical, 16)
            Divider().opacity(0.5)
            if conflicted {
                HStack {
                    Text(friday: "另一台设备已修改这篇笔记，你的版本已保留。").font(.caption)
                    Spacer()
                    Button(friday: "另存为新笔记") { _ = autosave(asNew: true, immediately: true) }.buttonStyle(FridayButtonStyle(compact: true))
                }.padding(14).background(.orange.opacity(0.08))
            }
            if let localError { Text(localError).font(.caption).foregroundStyle(.orange).padding(12).textSelection(.enabled) }
            editor
        }
        .onAppear { _ = autosave() }
        .onDisappear { _ = autosave(immediately: true) }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { _ = autosave(immediately: true) }
        }
        #if os(macOS)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
            _ = autosave(immediately: true)
        }
        #endif
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            Button { _ = autosave(immediately: true); close() } label: { FridaySymbolLabel(friday: "所有笔记", systemImage: "chevron.left") }
                .buttonStyle(FridayButtonStyle(compact: true))
            Spacer()
            if let current {
                Button {
                    Task {
                        guard autosave(immediately: true) else { return }
                        await store.flushOutbox()
                        if let note = self.current, !store.outbox.contains(where: { $0.id == note.id }) { delegate(note) }
                    }
                } label: { FridaySymbolLabel(friday: current.taskId == nil ? "交给 Friday" : "打开对话", systemImage: current.taskId == nil ? "arrow.up.right" : FridaySymbols.chat) }
                    .buttonStyle(FridayButtonStyle(compact: true)).disabled(pending || (!store.connected && current.taskId == nil) || store.delegatingIdeas.contains(current.id))
            }
            Text(friday: hasChanges || pending ? "已保存在本机，待同步" : hasContent ? "已自动保存" : "自动保存")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 16) {
            TextField(friday: "标题", text: draftBinding(\.title), axis: .vertical).textFieldStyle(.plain).font(.largeTitle.weight(.semibold))
                .accessibilityLabel(Text(friday: "笔记标题"))
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(friday: "创建时间").foregroundStyle(.tertiary)
                    Text(noteDate(draft.createdAt, time: true)).foregroundStyle(.secondary)
                }
                if let modified = current?.updatedAt, modified != draft.createdAt {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(friday: "修改时间").foregroundStyle(.tertiary)
                        Text(noteDate(modified, time: true)).foregroundStyle(.secondary)
                    }
                }
                if pending { FridaySymbolLabel(friday: "待同步", systemImage: "clock").foregroundStyle(.secondary) }
            }.font(.caption)
            Divider()
            IdeaBodyEditor(text: draft.text, images: draft.images, imageData: { try await store.imageData($0) }, onChange: { text, images in
                draft.text = text; draft.images = images; localError = nil
                _ = autosave()
            }, onError: { localError = $0 })
                .frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityLabel(Text(friday: "笔记正文"))
                .overlay(alignment: .topLeading) {
                    if draft.text.isEmpty { Text(friday: "记下一个念头，或写写今天发生的事……").foregroundStyle(.tertiary).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false) }
                }
        }
        .padding(28).frame(maxWidth: 840).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func persistDraft() {
        guard hasChanges else { UserDefaults.standard.removeObject(forKey: draftKey); return }
        UserDefaults.standard.set(try? JSONEncoder().encode(draft), forKey: draftKey)
    }
    private func draftBinding(_ keyPath: WritableKeyPath<IdeaDraft, String>) -> Binding<String> {
        Binding(get: { draft[keyPath: keyPath] }, set: { value in
            draft[keyPath: keyPath] = value
            _ = autosave()
        })
    }
    @discardableResult private func autosave(asNew: Bool = false, immediately: Bool = false) -> Bool {
        guard asNew || hasChanges else {
            if immediately { store.scheduleNoteSync(immediately: true) }
            return true
        }
        guard hasContent else { persistDraft(); return false }
        let submitted = draft
        let id = asNew ? UUID().uuidString : submitted.id
        let createdAt = asNew ? ISO8601DateFormatter().string(from: Date()) : submitted.createdAt
        var version = submitted.expectedUpdatedAt
        if let remote = store.ideas.first(where: { $0.id == id }) {
            let acknowledged = IdeaDraft(remote)
            // A previous offline save can finish syncing while this editor stays open.
            // Advance only if the host still contains the content we last saved.
            if acknowledged.title == baseline.title.trimmingCharacters(in: .whitespacesAndNewlines)
                && acknowledged.text == baseline.text.trimmingCharacters(in: .whitespacesAndNewlines)
                && acknowledged.images == baseline.images {
                version = remote.updatedAt ?? remote.createdAt
            }
        }
        guard store.enqueueNote(id: id, title: submitted.title, text: submitted.text, images: submitted.images, createdAt: createdAt, expectedUpdatedAt: asNew ? nil : version, taskId: asNew ? nil : submitted.taskId) else {
            localError = store.error
            persistDraft()
            return false
        }
        if asNew { store.outbox.removeAll { $0.id == submitted.id }; store.persistPendingNotes() }
        savedID = id
        draft.id = id; draft.createdAt = createdAt
        draft.expectedUpdatedAt = asNew ? nil : version; draft.taskId = asNew ? nil : submitted.taskId
        baseline = draft
        persistDraft()
        if initial == nil { UserDefaults.standard.removeObject(forKey: "friday.ideaDraft") }
        store.scheduleNoteSync(immediately: immediately)
        return true
    }
}

private func noteDate(_ value: String, time: Bool) -> String {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return value.isEmpty ? "—" : value }
    let language = FridayLanguage(rawValue: UserDefaults.standard.string(forKey: FridayPreferenceKeys.language) ?? "") ?? .chinese
    return date.formatted(Date.FormatStyle(date: .abbreviated, time: time ? .shortened : .omitted).locale(language.locale))
}
