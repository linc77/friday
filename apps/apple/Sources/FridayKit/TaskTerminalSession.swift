import Foundation
import SwiftUI
import SwiftTerm

@MainActor
final class TaskTerminalSessions {
    private var sessions: [String: TaskTerminalSession] = [:]
    private var recent: [String] = []
    func session(connection: Connection, terminal: TaskTerminalSummary) -> TaskTerminalSession {
        let key = connection.server + "\n" + connection.token + "\n" + terminal.taskId + "\n" + terminal.id
        recent.removeAll { $0 == key }; recent.append(key)
        if let current = sessions[key] { return current }
        let created = TaskTerminalSession(connection: connection, terminal: terminal); sessions[key] = created
        while sessions.count > 32, let oldest = recent.first(where: { sessions[$0]?.attached == false }) {
            sessions[oldest]?.discard(); sessions.removeValue(forKey: oldest); recent.removeAll { $0 == oldest }
        }
        return created
    }
}

@MainActor
final class TaskTerminalSession: NSObject, ObservableObject, @preconcurrency TerminalViewDelegate {
    @Published private(set) var terminal: TaskTerminalSummary
    @Published private(set) var connected = false
    @Published private(set) var error: String?
    @Published private(set) var inputProblem: String?
    @Published private(set) var truncated = false
    @Published private(set) var capturingSelection = false
    @Published private(set) var selectionError: String?
    let surface: FridayTerminalView
    var onFocus: (() -> Void)?
    var onFind: (() -> Void)?
    var openBrowserLink:((URL)->Bool)?
    var browserLinkOwner:UUID?
    var onAddSelection: ((TaskTerminalSelection) async -> Bool)?
    var canAddContext = false
    private(set) var attached = false
    private let connection: Connection
    private let server: String
    private let token: String
    private let path: String
    private var streamTask: Task<Void, Never>?
    private var inputTask: Task<Void, Never>?
    private var resizeTask: Task<Void, Never>?
    private var pending = Data()
    private var pendingGeneration: Int?
    private var cursor = TaskTerminalCursor()
    private var replaying = false
    private var dimensions: (Int, Int)?
    private var lastResize: (generation: Int, cols: Int, rows: Int)?
    private var fontSize: CGFloat = 13

    init(connection: Connection, terminal: TaskTerminalSummary) {
        self.connection = connection; self.server = connection.server; self.token = connection.token; self.terminal = terminal
        path = "/api/tasks/" + terminal.taskId + "/terminals/" + terminal.id
        surface = FridayTerminalView(frame: .zero)
        super.init()
        surface.terminalDelegate = self; surface.changeScrollback(5000)
        surface.focusReceived = { [weak self] in self?.onFocus?() }
        surface.findRequested = { [weak self] in self?.onFind?() }
        surface.canPaste = { [weak self] in self?.connected == true && self?.terminal.canType == true && self?.inputProblem == nil }
        surface.canAddSelection = { [weak self] in self?.canAddContext == true && self?.capturingSelection == false }
        surface.addSelection = { [weak self] in self?.addSelectionToTask() }
        setFontSize(13)
        #if os(macOS)
        surface.nativeBackgroundColor = .textBackgroundColor; surface.nativeForegroundColor = .textColor
        #else
        surface.nativeBackgroundColor = .systemBackground; surface.nativeForegroundColor = .label
        #endif
    }
    func sync(_ value: TaskTerminalSummary) {
        guard terminal != value else { return }; terminal = value
        if value.status == "closed" { detach() }
    }
    func setFontSize(_ value: Double) {
        let size = CGFloat(max(9, min(24, value))); guard size != fontSize || surface.font.pointSize != size else { return }; fontSize = size
        #if os(macOS)
        surface.font = .monospacedSystemFont(ofSize: size, weight: .regular)
        #else
        surface.font = .monospacedSystemFont(ofSize: size, weight: .regular)
        #endif
    }
    private func request(_ suffix: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        guard connection.server == server, connection.token == token else { throw ConnectionError.message("主机连接已切换") }
        return try connection.request(path + suffix, method: method, body: body)
    }
    private func data(_ suffix: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        let (bytes, response) = try await URLSession.shared.data(for: request(suffix, method: method, body: body))
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
            throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: bytes).error) ?? "终端连接暂时不可用")
        }
        return bytes
    }
    func attach() {
        guard !attached else { return }; attached = true; startStream()
    }
    func detach() { attached = false; connected = false; streamTask?.cancel(); streamTask = nil; resizeTask?.cancel() }
    func discard() { detach(); onFind = nil; onFocus = nil }
    private func startStream() {
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            guard let self else { return }
            while self.attached && !Task.isCancelled {
                do {
                    var suffix = "/events"
                    if let generation = self.cursor.generation { suffix += "?generation=\(generation)&after=\(self.cursor.sequence)" }
                    var request = try self.request(suffix); request.timeoutInterval = 30; request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ConnectionError.message("终端连接授权失效或会话已被移除") }
                    var decoder = TaskTerminalStream()
                    for try await line in bytes.lines {
                        if Task.isCancelled { return }
                        if let event = try decoder.read(line) { try self.receive(event) }
                    }
                    self.connected = false
                } catch {
                    if Task.isCancelled { return }; self.connected = false; self.error = error.localizedDescription
                    if error is TaskTerminalProtocolError { self.cursor.invalidate() }
                }
                if !self.attached || self.terminal.status == "closed" { return }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
    private func reset() {
        replaying = true; surface.feed(text: "\u{1b}c\u{1b}[3J"); replaying = false; surface.clearSearch()
    }
    private func feed(_ value: String?) throws {
        guard let value, let decoded = Data(base64Encoded: value) else { throw TaskTerminalProtocolError.invalidData }
        surface.feed(byteArray: Array(decoded)[...])
    }
    private func receive(_ event: TaskTerminalEvent) throws {
        let action = try cursor.apply(event)
        switch action {
        case .ignore: return
        case .snapshot:
            guard let metadata = event.terminal else { throw ConnectionError.message("终端快照缺少会话信息") }
            reset(); replaying = true; defer { replaying = false }
            try feed(event.history); terminal = metadata; truncated = event.truncated == true
            connected = metadata.status != "closed"; error = nil; updateSize(); return
        case .metadata, .resetMetadata:
            // A new shell generation has an empty buffer until its snapshot.
            if action == .resetMetadata { reset(); truncated = false }
            if let metadata = event.terminal { terminal = metadata }
            connected = terminal.status != "closed"; error = nil; updateSize(); return
        case .output: try feed(event.data)
        case .clear: reset(); truncated = false
        case .closed: connected = false
        }
    }
    func resumeInput() { inputProblem = nil }
    private func enqueue(_ data: Data) {
        guard !replaying else { return }
        guard connected, terminal.canType, inputProblem == nil, cursor.generation == terminal.generation else { return }
        guard pending.count + data.count <= 1024 * 1024 else { inputProblem = "粘贴内容过大，尚未发送的输入已取消。"; pending.removeAll(); return }
        if pendingGeneration != cursor.generation { pending.removeAll(); pendingGeneration = cursor.generation }
        pending.append(data)
        guard inputTask == nil else { return }
        inputTask = Task { [weak self] in
            guard let self else { return }; try? await Task.sleep(for: .milliseconds(16))
            defer { self.inputTask = nil }
            while !self.pending.isEmpty {
                guard let expected = self.pendingGeneration, self.connected, self.cursor.generation == expected, self.inputProblem == nil else { self.pending.removeAll(); return }
                let chunk = Data(self.pending.prefix(65_536)); self.pending.removeFirst(chunk.count); let id = UUID().uuidString
                struct Receipt: Decodable { let state: String }
                var sent = false
                do {
                    let response = try await self.data("/input", method: "POST", body: ["requestId": id, "generation": expected, "data": chunk.base64EncodedString()])
                    sent = try JSONDecoder().decode(Receipt.self, from: response).state == "sent"
                } catch {
                    // Query only. A lost HTTP response must never resend a command.
                    struct Response: Decodable { let receipt: Receipt? }
                    for attempt in 0..<3 {
                        if attempt > 0 { try? await Task.sleep(for: .milliseconds(500)) }
                        if let response = try? await self.data("/input/" + id), let value = try? JSONDecoder().decode(Response.self, from: response), value.receipt?.state == "sent" { sent = true; break }
                    }
                }
                if !sent { self.pending.removeAll(); self.inputProblem = "上一段输入是否送达尚未确认。请检查终端内容后再继续输入；不会自动重发。"; return }
            }
        }
    }
    func clear() async {
        do { _ = try await data("/clear", method: "POST", body: ["generation": terminal.generation]); error = nil }
        catch { self.error = error.localizedDescription }
    }
    func find(_ text: String, backwards: Bool = false) -> String {
        guard !text.isEmpty else { surface.clearSearch(); return "" }
        if backwards { surface.findPrevious(text) } else { surface.findNext(text) }
        let result = surface.searchMatchSummary(text); return "\(result.index)/\(result.total)"
    }
    func copySelection() {
        guard let text = surface.getSelection(), !text.isEmpty else { return }
        #if os(macOS)
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
    func addSelectionToTask() {
        guard canAddContext, !capturingSelection, let generation = cursor.generation, let text = surface.getSelection(), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let callback = onAddSelection else { return }
        let start = min(surface.selection.start.row, surface.selection.end.row) + 1
        let end = max(start, max(surface.selection.start.row, surface.selection.end.row) + 1)
        let selection = TaskTerminalSelection(terminalID: terminal.id, generation: generation, lineStart: start, lineEnd: end, text: text)
        capturingSelection = true; selectionError = nil
        Task { [weak self] in
            guard let self else { return }; defer { self.capturingSelection = false }
            let accepted = await callback(selection)
            if accepted, self.cursor.generation == generation, self.surface.getSelection() == text { self.surface.selectNone() }
            if !accepted { self.selectionError = "引用未能添加，选区已保留；请检查任务输入框后重试。" }
        }
    }
    private func updateSize() {
        guard let dimensions, connected, terminal.canType else { return }
        if lastResize?.generation == terminal.generation && lastResize?.cols == dimensions.0 && lastResize?.rows == dimensions.1 { return }
        if terminal.cols == dimensions.0 && terminal.rows == dimensions.1 { return }
        resizeTask?.cancel(); let expected = terminal.generation
        resizeTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(120)) } catch { return }; guard let self, self.connected, self.terminal.generation == expected else { return }
            self.lastResize = (expected, dimensions.0, dimensions.1)
            do { _ = try await self.data("/resize", method: "POST", body: ["generation": expected, "cols": dimensions.0, "rows": dimensions.1]) } catch { self.lastResize = nil; if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard !replaying, newCols > 0, newRows > 0, newCols <= 1000, newRows <= 500 else { return }
        guard dimensions?.0 != newCols || dimensions?.1 != newRows else { return }; dimensions = (newCols, newRows); updateSize()
    }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func send(source: TerminalView, data: ArraySlice<UInt8>) { enqueue(Data(data)) }
    func scrolled(source: TerminalView, position: Double) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
        if ["http","https"].contains(url.scheme?.lowercased() ?? ""),openBrowserLink?(url)==true {return}
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        UIApplication.shared.open(url)
        #endif
    }
    func bell(source: TerminalView) {}
    func clipboardCopy(source: TerminalView, content: Data) {}
    func clipboardRead(source: TerminalView) -> Data? { nil }
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

#if os(macOS)
import AppKit
final class FridayTerminalView: TerminalView {
    var focusReceived: (() -> Void)?
    var findRequested: (() -> Void)?
    var canPaste: (() -> Bool)?
    var canAddSelection: (() -> Bool)?
    var addSelection: (() -> Void)?
    override func mouseDown(with event: NSEvent) { focusReceived?(); super.mouseDown(with: event) }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if window?.firstResponder === self, event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "f" { findRequested?(); return true }
        return super.performKeyEquivalent(with: event)
    }
    override func performFindPanelAction(_ sender: Any?) { findRequested?() }
    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu(); menu.autoenablesItems = false
        let add = NSMenuItem(title: String(localized: "添加到任务输入框", bundle: .module), action: #selector(addSelectedContext), keyEquivalent: ""); add.target = self; add.isEnabled = canAddSelection?() == true && getSelection()?.isEmpty == false; menu.addItem(add)
        let copy = NSMenuItem(title: String(localized: "复制", bundle: .module), action: #selector(copy(_:)), keyEquivalent: ""); copy.target = self; copy.isEnabled = getSelection()?.isEmpty == false; menu.addItem(copy)
        let paste = NSMenuItem(title: String(localized: "粘贴", bundle: .module), action: #selector(paste(_:)), keyEquivalent: ""); paste.target = self; paste.isEnabled = canPaste?() == true; menu.addItem(paste)
        menu.addItem(.separator()); let find = NSMenuItem(title: String(localized: "搜索终端", bundle: .module), action: #selector(findText), keyEquivalent: ""); find.target = self; menu.addItem(find)
        return menu
    }
    @objc private func findText() { findRequested?() }
    @objc private func addSelectedContext() { addSelection?() }
}
struct TaskTerminalSurface: NSViewRepresentable {
    let session: TaskTerminalSession
    @Environment(\.taskBrowserOpen) private var browserOpen
    func makeCoordinator()->TaskTerminalBrowserLinkOwner {TaskTerminalBrowserLinkOwner(session)}
    func makeNSView(context: Context) -> FridayTerminalView { session.surface }
    func updateNSView(_ view: FridayTerminalView, context: Context) {session.browserLinkOwner=context.coordinator.id;session.openBrowserLink=browserOpen}
    static func dismantleNSView(_ view:FridayTerminalView,coordinator:TaskTerminalBrowserLinkOwner) {coordinator.clear()}
}
#else
import UIKit
final class FridayTerminalView: TerminalView {
    var focusReceived: (() -> Void)?
    var findRequested: (() -> Void)?
    var canPaste: (() -> Bool)?
    var canAddSelection: (() -> Bool)?
    var addSelection: (() -> Void)?
    override func becomeFirstResponder() -> Bool { focusReceived?(); return super.becomeFirstResponder() }
    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        let action = UIAction(title: String(localized: "添加到任务输入框", bundle: .module), attributes: canAddSelection?() == true && getSelection()?.isEmpty == false ? [] : [.disabled]) { [weak self] _ in self?.addSelection?() }
        builder.insertChild(UIMenu(options: .displayInline, children: [action]), atStartOfMenu: .standardEdit)
    }
}
struct TaskTerminalSurface: UIViewRepresentable {
    let session: TaskTerminalSession
    @Environment(\.taskBrowserOpen) private var browserOpen
    func makeCoordinator()->TaskTerminalBrowserLinkOwner {TaskTerminalBrowserLinkOwner(session)}
    func makeUIView(context: Context) -> FridayTerminalView { session.surface }
    func updateUIView(_ view: FridayTerminalView, context: Context) {session.browserLinkOwner=context.coordinator.id;session.openBrowserLink=browserOpen}
    static func dismantleUIView(_ view:FridayTerminalView,coordinator:TaskTerminalBrowserLinkOwner) {coordinator.clear()}
}
#endif

@MainActor final class TaskTerminalBrowserLinkOwner {
    let id=UUID();weak var session:TaskTerminalSession?
    init(_ session:TaskTerminalSession) {self.session=session}
    func clear() {if session?.browserLinkOwner==id {session?.openBrowserLink=nil;session?.browserLinkOwner=nil}}
}
