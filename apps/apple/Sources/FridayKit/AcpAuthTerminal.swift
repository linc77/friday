import SwiftUI
import SwiftTerm

struct AcpTerminalOutputCursor {
    private(set) var offset: Int?
    mutating func reset() { offset = nil }
    mutating func receive(_ text: String, end: Int) -> (reset: Bool, text: String) {
        let value = text as NSString, length = value.length
        guard end >= length, end >= 0 else { return (false, "") }
        if let offset, end <= offset { return (false, "") }
        let start = end - length, previous = offset
        offset = end
        guard let previous, previous >= start else { return (true, text) }
        return (false, value.substring(from: previous - start))
    }
}

/// Uses the same native terminal surface as task terminals. Only output is
/// replayable; uncertain input is reported and is never automatically resent.
@MainActor final class AcpAuthTerminalState: NSObject, ObservableObject, @preconcurrency TerminalViewDelegate {
    let surface = FridayTerminalView(frame: .zero)
    @Published private(set) var inputProblem: String?
    private var flow: String?
    private var active = false
    private var cursor = AcpTerminalOutputCursor()
    private var pending = Data()
    private var dimensions: (Int, Int)?
    private var lastDimensions: (Int, Int)?
    private var input: Task<Void, Never>?
    private var inputOperation = UUID()
    private var respond: ((String?, Int?, Int?) async throws -> Void)?
    override init() {
        super.init()
        surface.terminalDelegate = self
        surface.changeScrollback(1000)
        surface.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        surface.canPaste = { [weak self] in self?.active == true && self?.inputProblem == nil }
        #if os(macOS)
        surface.nativeBackgroundColor = .textBackgroundColor; surface.nativeForegroundColor = .textColor
        #else
        surface.nativeBackgroundColor = .systemBackground; surface.nativeForegroundColor = .label
        #endif
    }
    func clear() {
        inputOperation = UUID(); input?.cancel(); input = nil; pending = Data(); active = false; flow = nil; cursor.reset(); lastDimensions = nil; inputProblem = nil; respond = nil
        surface.feed(text: "\u{1b}c\u{1b}[3J")
    }
    func receive(_ state: AcpNativeLoginState, respond: @escaping (String?, Int?, Int?) async throws -> Void) {
        if flow != state.flowId { clear(); flow = state.flowId }
        self.respond = respond
        active = state.pending && state.interaction?.type == "terminal"
        guard active, let output = state.interaction?.output, let end = state.interaction?.outputOffset else { pending = Data(); return }
        let change = cursor.receive(output, end: end)
        if change.reset { surface.feed(text: "\u{1b}c\u{1b}[3J") }
        if !change.text.isEmpty { surface.feed(text: change.text) }
        flush()
    }
    private func flush() {
        guard input == nil, active, inputProblem == nil, respond != nil else { return }
        let changed = dimensions.map { size in lastDimensions?.0 != size.0 || lastDimensions?.1 != size.1 } ?? false
        guard !pending.isEmpty || changed else { return }
        let owner = flow
        let operation = UUID(); inputOperation = operation
        input = Task { [weak self] in
            await Task.yield()
            guard let self else { return }
            defer { if self.inputOperation == operation { self.input = nil; if self.flow == owner { self.flush() } } }
            while self.active, self.flow == owner, !Task.isCancelled, self.inputProblem == nil {
                let resize = self.dimensions.flatMap { size in self.lastDimensions?.0 != size.0 || self.lastDimensions?.1 != size.1 ? size : nil }
                guard !self.pending.isEmpty || resize != nil, let respond = self.respond else { return }
                let bytes = self.pending; self.pending = Data()
                do {
                    try await respond(bytes.isEmpty ? nil : String(decoding: bytes, as: UTF8.self), resize?.0, resize?.1)
                    if let resize { self.lastDimensions = resize }
                } catch {
                    guard self.flow == owner, !Task.isCancelled else { return }
                    self.inputProblem = "认证终端输入结果尚未确认，不会自动重发；请检查主机状态或取消后重新登录。"
                }
            }
        }
    }
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        dimensions = (max(2, min(500, newCols)), max(2, min(300, newRows))); flush()
    }
    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        guard active, inputProblem == nil else { return }
        guard pending.count + data.count <= 16384 else { inputProblem = "认证终端输入过长，请取消后重新登录。"; return }
        pending.append(contentsOf: data); flush()
    }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
    func bell(source: TerminalView) {}
    func clipboardCopy(source: TerminalView, content: Data) {}
    func clipboardRead(source: TerminalView) -> Data? { nil }
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

#if os(macOS)
struct AcpAuthTerminalSurface: NSViewRepresentable {
    let state: AcpAuthTerminalState
    func makeNSView(context: Context) -> FridayTerminalView { state.surface }
    func updateNSView(_ view: FridayTerminalView, context: Context) {}
}
#else
struct AcpAuthTerminalSurface: UIViewRepresentable {
    let state: AcpAuthTerminalState
    func makeUIView(context: Context) -> FridayTerminalView { state.surface }
    func updateUIView(_ view: FridayTerminalView, context: Context) {}
}
#endif
