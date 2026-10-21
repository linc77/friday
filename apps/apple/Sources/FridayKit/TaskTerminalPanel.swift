import SwiftUI

private struct TerminalGroup: Codable, Equatable, Identifiable {
    var id = UUID().uuidString
    var terminals: [String]
}
private struct TerminalLayout: Codable, Equatable {
    var groups: [TerminalGroup] = []
    var selected: String? = nil
    var active: String? = nil
}
private struct TerminalAction: Identifiable {
    let id = UUID().uuidString
    let kind: String
    let terminal: String
    var force = false
    var group: String? = nil
}

struct TaskTerminalPanel: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let close: () -> Void
    var canAddContext = false
    var addContext: (TaskTerminalSelection) async -> Bool = { _ in false }
    @State private var layout = TerminalLayout()
    @State private var loaded = false
    @State private var busy = false
    @State private var error: String?
    @State private var pending: TerminalAction?
    @State private var confirmation: TerminalAction?
    @State private var renameID: String?
    @State private var renameText = ""
    @State private var showSearch = false
    @State private var query = ""
    @State private var match = ""
    @FocusState private var searchFocused: Bool
    @AppStorage("friday.terminal.fontSize") private var fontSize = 13.0
    private var terminals: [TaskTerminalSummary] { (task.terminals ?? []).filter { $0.status != "closed" } }
    private var selected: TerminalGroup? { layout.groups.first { $0.id == layout.selected } ?? layout.groups.first }
    private var active: TaskTerminalSummary? { terminals.first { $0.id == layout.active && selected?.terminals.contains($0.id) == true } ?? terminals.first { selected?.terminals.contains($0.id) == true } }
    private func session(_ row: TaskTerminalSummary) -> TaskTerminalSession { store.terminalSessions.session(connection: store.connection, terminal: row) }
    private var context: String { "task-terminal-layout:" + task.id }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            if showSearch { searchBar }
            if let error {
                HStack {
                    Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled).lineLimit(3)
                    Spacer(minLength: 0)
                    if let pending { Button(friday: "重试") { perform(pending) }.disabled(busy || !store.connected) }
                    Button { self.error = nil; pending = nil } label: { FridaySymbolImage(systemName: "xmark") }.buttonStyle(FridaySymbolButtonStyle())
                }.padding(.horizontal, 10).padding(.vertical, 6)
            }
            Divider()
            if let selected {
                HStack(spacing: 1) {
                    ForEach(selected.terminals, id: \.self) { id in
                        if let terminal = terminals.first(where: { $0.id == id }) {
                            TaskTerminalPane(session: session(terminal), metadata: terminal, fontSize: fontSize, active: active?.id == id, canAddContext: canAddContext, addContext: addContext,
                                activate: { layout.active = id }, find: { layout.active = id; showSearch = true; searchFocused = true },
                                restart: { request("restart", terminal: id) }, close: { request("close", terminal: id) })
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                }.background(.primary.opacity(0.12))
            } else {
                VStack(spacing: 8) {
                    Text(friday: busy ? "正在打开终端…" : "尚未打开终端").foregroundStyle(.secondary)
                    if !busy { Button(friday: "新建终端", systemImage: "plus") { create(split: false) }.disabled(!store.connected) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(FridayTheme.canvas)
        .onAppear {
            layout = TaskDraftCache.load(TerminalLayout.self, server: store.connection.server, context: context) ?? TerminalLayout(); loaded = true; synchronize()
            if terminals.isEmpty { create(split: false) }
        }
        .onChange(of: terminals) { _, _ in synchronize() }
        .onChange(of: layout) { _, value in if loaded { TaskDraftCache.save(value, server: store.connection.server, context: context) } }
        .onChange(of: query) { _, _ in search() }
        .onChange(of: layout.active) { _, _ in if showSearch { search() } }
        .confirmationDialog(Text(friday: "停止终端中的程序？"), isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
            if let value = confirmation {
                Button(friday: value.kind == "restart" ? "停止并重新启动" : "停止并关闭", role: .destructive) { var confirmed = value; confirmed.force = true; confirmation = nil; perform(confirmed) }
            }
            Button(friday: "取消", role: .cancel) { confirmation = nil }
        } message: { Text(friday: "终端仍有程序在运行，停止后尚未完成的工作会中断。") }
        .alert(Text(friday: "重命名终端"), isPresented: Binding(get: { renameID != nil }, set: { if !$0 { renameID = nil } })) {
            TextField(friday: "终端名称", text: $renameText)
            Button(friday: "保存") { rename() }.disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button(friday: "取消", role: .cancel) { renameID = nil }
        }
    }
    private var toolbar: some View {
        HStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(layout.groups) { group in
                        Button { layout.selected = group.id; layout.active = group.terminals.first } label: {
                            HStack(spacing: 5) {
                                FridaySymbolImage(systemName: "terminal").font(.system(size: 11))
                                Text(verbatim: terminals.first { $0.id == group.terminals.first }?.label ?? "Terminal").lineLimit(1)
                                if group.terminals.count > 1 { Text("+\(group.terminals.count - 1)").foregroundStyle(.secondary) }
                            }.font(.caption).padding(.horizontal, 8).padding(.vertical, 5)
                                .background(group.id == selected?.id ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 5))
                        }.buttonStyle(.plain).fridayInteractiveCursor()
                        .contextMenu {
                            ForEach(group.terminals, id: \.self) { id in
                                if let terminal = terminals.first(where: { $0.id == id }) {
                                    Button { renameID = id; renameText = terminal.label } label: { Text(verbatim: terminal.label); Text(friday: "重命名终端") }
                                    Button(friday: "关闭终端", role: .destructive) { request("close", terminal: id) }
                                }
                            }
                        }
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            Button { create(split: false) } label: { FridaySymbolImage(systemName: "plus") }.buttonStyle(FridaySymbolButtonStyle())
                .disabled(busy || !store.connected || terminals.count >= 16).help(Text(friday: "新建终端"))
            Button { create(split: true) } label: { FridaySymbolImage(systemName: "rectangle.split.2x1") }.buttonStyle(FridaySymbolButtonStyle())
                .disabled(busy || !store.connected || terminals.count >= 16 || (selected?.terminals.count ?? 0) >= 4).help(Text(friday: "拆分终端"))
            Button { showSearch.toggle(); searchFocused = showSearch; if !showSearch { query = "" } } label: { FridaySymbolImage(systemName: "magnifyingglass") }.buttonStyle(FridaySymbolButtonStyle())
                .disabled(active == nil).help(Text(friday: "搜索终端"))
            Menu {
                if let active {
                    Button(friday: "重命名终端") { renameID = active.id; renameText = active.label }
                    Button(friday: "复制选中文字") { session(active).copySelection() }
                    Button(friday: "添加选区到任务") { session(active).addSelectionToTask() }.disabled(!canAddContext)
                    Button(friday: "清空终端") { Task { await session(active).clear() } }
                    Button(friday: "重新启动终端") { request("restart", terminal: active.id) }.disabled(!active.canRestart || busy)
                    Button(friday: "关闭终端", role: .destructive) { request("close", terminal: active.id) }.disabled(busy)
                    Divider()
                }
                Button(friday: "增大终端字体") { fontSize = min(24, fontSize + 1) }
                Button(friday: "减小终端字体") { fontSize = max(9, fontSize - 1) }
                Button(friday: "重置终端字体") { fontSize = 13 }
            } label: { FridaySymbolImage(systemName: "ellipsis").frame(width: 22, height: 22) }.menuStyle(.borderlessButton).fridayInteractiveCursor()
            Button(action: close) { FridaySymbolImage(systemName: "chevron.down") }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "收起终端"))
        }.padding(.horizontal, 10).padding(.vertical, 5)
    }
    private var searchBar: some View {
        HStack(spacing: 8) {
            TextField(friday: "搜索终端", text: $query).textFieldStyle(.roundedBorder).focused($searchFocused).onSubmit { search() }
            Text(verbatim: match).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            Button { search(backwards: true) } label: { FridaySymbolImage(systemName: "chevron.up") }.buttonStyle(FridaySymbolButtonStyle())
            Button { search() } label: { FridaySymbolImage(systemName: "chevron.down") }.buttonStyle(FridaySymbolButtonStyle())
            Button { query = ""; showSearch = false } label: { FridaySymbolImage(systemName: "xmark") }.buttonStyle(FridaySymbolButtonStyle())
        }.padding(.horizontal, 10).padding(.bottom, 6)
    }
    private func search(backwards: Bool = false) { if let active { match = session(active).find(query, backwards: backwards) } }
    private func synchronize() {
        guard loaded else { return }; let existing = Set(terminals.map(\.id))
        for index in layout.groups.indices { layout.groups[index].terminals.removeAll { !existing.contains($0) } }
        layout.groups.removeAll { $0.terminals.isEmpty }; let grouped = Set(layout.groups.flatMap(\.terminals))
        for terminal in terminals where !grouped.contains(terminal.id) { layout.groups.append(TerminalGroup(terminals: [terminal.id])) }
        if !layout.groups.contains(where: { $0.id == layout.selected }) { layout.selected = layout.groups.first?.id }
        if !existing.contains(layout.active ?? "") { layout.active = selected?.terminals.first }
    }
    private func create(split: Bool) {
        guard !busy else { return }
        perform(TerminalAction(kind: "open", terminal: "term-" + UUID().uuidString, group: split ? selected?.id : nil))
    }
    private func request(_ kind: String, terminal: String) {
        let action = TerminalAction(kind: kind, terminal: terminal)
        if terminals.first(where: { $0.id == terminal })?.hasRunningSubprocess == true { confirmation = action } else { perform(action) }
    }
    private func perform(_ action: TerminalAction) {
        guard !busy else { return }; busy = true; error = nil; pending = action
        let server = store.connection.server; let taskID = task.id
        Task { @MainActor in
            defer { busy = false }
            do {
                _ = try await store.connection.data("/api/tasks/\(taskID)/terminals", method: "POST", body: ["terminalId": action.terminal, "requestId": action.id, "action": action.kind, "force": action.force])
                guard store.connection.server == server else { return }; await store.refresh(); guard store.connection.server == server else { return }; synchronize()
                if action.kind == "open" {
                    layout.groups.removeAll { $0.terminals == [action.terminal] }
                    if let group = action.group, let index = layout.groups.firstIndex(where: { $0.id == group }) { layout.groups[index].terminals.append(action.terminal); layout.selected = group }
                    else { let group = TerminalGroup(terminals: [action.terminal]); layout.groups.append(group); layout.selected = group.id }
                    layout.active = action.terminal
                }
                pending = nil
            } catch {
                guard store.connection.server == server else { return }; self.error = error.localizedDescription
                if error.localizedDescription.contains("确认"), action.kind != "open" { confirmation = action }
                await store.refresh()
            }
        }
    }
    private func rename() {
        guard let id = renameID else { return }; let label = renameText; renameID = nil
        Task { do { _ = try await store.connection.data("/api/tasks/\(task.id)/terminals/\(id)", method: "PATCH", body: ["label": label]); await store.refresh() } catch { self.error = error.localizedDescription } }
    }
}

private struct TaskTerminalPane: View {
    @ObservedObject var session: TaskTerminalSession
    let metadata: TaskTerminalSummary
    let fontSize: Double
    let active: Bool
    let canAddContext: Bool
    let addContext: (TaskTerminalSelection) async -> Bool
    let activate: () -> Void
    let find: () -> Void
    let restart: () -> Void
    let close: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Circle().fill(session.terminal.canType ? Color.green : Color.secondary).frame(width: 5, height: 5)
                Text(verbatim: session.terminal.label).font(.caption).lineLimit(1)
                Text(verbatim: session.terminal.title).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 0)
                if !session.terminal.canType, session.terminal.canRestart { Button(action: restart) { FridaySymbolImage(systemName: "arrow.clockwise") }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "重新启动终端")) }
                Button(action: close) { FridaySymbolImage(systemName: "xmark") }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "关闭终端"))
            }.padding(.horizontal, 8).padding(.vertical, 4).background(active ? FridayTheme.accent.opacity(0.06) : .clear)
            TaskTerminalSurface(session: session).frame(maxWidth: .infinity, maxHeight: .infinity).padding(.horizontal, 4)
            if let problem = session.inputProblem {
                HStack { Text(fridayString: problem).font(.caption).foregroundStyle(.orange); Button(friday: "继续输入") { session.resumeInput() } }.padding(6)
            } else if session.capturingSelection {
                Text(friday: "正在添加引用…").font(.caption).foregroundStyle(.secondary).padding(4)
            } else if let message = session.selectionError ?? session.error ?? session.terminal.error {
                Text(fridayString: message).font(.caption).foregroundStyle(.orange).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(6)
            } else if !session.connected {
                Text(friday: "正在连接终端…").font(.caption).foregroundStyle(.secondary).padding(4)
            } else if !session.terminal.canType {
                Text(friday: "终端已退出，历史输出已保留。").font(.caption).foregroundStyle(.secondary).padding(4)
            } else if session.truncated {
                Text(friday: "已加载最近的终端输出。").font(.caption2).foregroundStyle(.secondary).padding(3)
            }
        }.background(FridayTheme.canvas)
        .onAppear { session.sync(metadata); session.onFocus = activate; session.onFind = find; session.onAddSelection = addContext; session.canAddContext = canAddContext; session.setFontSize(fontSize); session.attach() }
        .onChange(of: canAddContext) { _, value in session.canAddContext = value }
        .onChange(of: metadata) { _, value in session.sync(value) }
        .onChange(of: fontSize) { _, value in session.setFontSize(value) }
        .onDisappear { session.onFocus = nil; session.onFind = nil; session.onAddSelection = nil; session.canAddContext = false; session.detach() }
    }
}

struct TaskTerminalPanelLayout: ViewModifier {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    @Binding var shown: Bool
    var canAddContext = false
    var addContext: (TaskTerminalSelection) async -> Bool = { _ in false }
    @AppStorage("friday.terminal.height") private var height = 300.0
    @State private var dragHeight: Double?
    func body(content: Content) -> some View {
        #if os(macOS)
        GeometryReader { geometry in
            let maximum = max(120, geometry.size.height - 200)
            let actual = min(maximum, max(120, height.isFinite ? height : 300))
            VStack(spacing: 0) {
                content.frame(maxWidth: .infinity, maxHeight: .infinity)
                if shown && task.localAgent {
                    Rectangle().fill(.primary.opacity(0.1)).frame(height: 5).contentShape(Rectangle())
                        .gesture(DragGesture().onChanged { gesture in if dragHeight == nil { dragHeight = actual }; height = min(maximum, max(120, (dragHeight ?? actual) - gesture.translation.height)) }.onEnded { _ in dragHeight = nil })
                        .fridayInteractiveCursor().accessibilityLabel(Text(friday: "调整终端高度"))
                        .accessibilityAdjustableAction { direction in height = min(maximum, max(120, height + (direction == .increment ? 40 : -40))) }
                    TaskTerminalPanel(store: store, task: task, close: { shown = false }, canAddContext: canAddContext, addContext: addContext).id(store.connection.server + "|" + task.id).frame(height: actual)
                }
            }
        }
        #else
        content.sheet(isPresented: $shown) { TaskTerminalPanel(store: store, task: task, close: { shown = false }, canAddContext: canAddContext, addContext: addContext).id(store.connection.server + "|" + task.id) }
        #endif
    }
}
