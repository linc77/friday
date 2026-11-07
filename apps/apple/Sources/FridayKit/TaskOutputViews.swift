import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor private func outputScope(_ store: FridayStore, _ task: WorkItem, _ event: TaskEvent) -> TaskOutputScope? {
    guard let epoch = task.conversationHistory?.epoch ?? task.history?.epoch else { return nil }
    return TaskOutputScope(connection: store.connectionIdentity, taskID: task.id, eventID: event.id, epoch: epoch)
}
@MainActor private func currentOutputScope(_ scope: TaskOutputScope, _ store: FridayStore) -> Bool {
    guard store.connectionIdentity == scope.connection, store.snapshotIdentity == scope.connection,
          let task = store.tasks.first(where: { $0.id == scope.taskID }) else { return false }
    if scope.native { return store.taskDetail(scope.taskID)?.nativeBackgroundWork?.contains { $0.id == scope.eventID && $0.transportId == scope.epoch } == true }
    return (task.conversationHistory?.epoch ?? task.history?.epoch) == scope.epoch
}

struct TaskToolOutputView: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let event: TaskEvent
    @State private var loaded: TaskEvent?
    @State private var loadedKey = ""
    @State private var error: String?
    @State private var retry = 0
    private var scope: TaskOutputScope? { outputScope(store, task, event) }
    private var requestKey: String { (scope?.key ?? "") + ":" + (event.status == "running" ? "live" : event.historyDigest ?? event.completedAt ?? event.at) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if loadedKey == requestKey, let loaded {
                let text = loaded.detail ?? ""
                if loaded.detailTruncated == true { Text(friday: "输出过大，仅显示部分内容").font(.caption).foregroundStyle(.secondary) }
                if text.isEmpty { Text(friday: "没有输出").font(.caption).foregroundStyle(.secondary) }
                else {
                    ScrollView { AgentMarkdown(text: text, compact: true).frame(maxWidth: .infinity, alignment: .leading) }
                        .frame(height: outputHeight(text, wraps: true))
                }
            } else if let error {
                Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                Button { retry += 1 } label: { FridaySymbolLabel(friday: "重新加载输出", systemImage: "arrow.clockwise") }
                    .buttonStyle(FridaySymbolButtonStyle()).font(.caption).disabled(!store.connected)
            } else { Text(friday: "正在加载输出…").font(.caption).foregroundStyle(.secondary) }
        }.task(id: requestKey + ":" + String(retry) + ":" + String(store.connected)) {
            let key = requestKey; loaded = nil; loadedKey = ""; error = nil
            guard store.connected, let scope else { return }
            do {
                let value = try await store.connection.decode(TaskEventDetail.self, scope.path)
                guard !Task.isCancelled, currentOutputScope(scope, store), requestKey == key else { return }
                guard let detail = scope.detail(value, event: event) else { throw TaskOutputError.historyChanged }
                loaded = detail; loadedKey = key
            } catch { if !Task.isCancelled && currentOutputScope(scope, store) { self.error = error.localizedDescription } }
        }
    }
}

struct TaskCommandOutputView: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let event: TaskEvent
    var nativeWork: TaskNativeBackgroundWork? = nil
    @State private var frame: TaskCommandOutputFrame?
    @State private var error: String?
    @State private var acceptedScope = ""
    @Environment(\.colorScheme) private var colorScheme
    private var scope: TaskOutputScope? {
        if let nativeWork { return TaskOutputScope(connection: store.connectionIdentity, taskID: task.id, eventID: nativeWork.id, epoch: nativeWork.transportId, native: true) }
        return outputScope(store, task, event)
    }
    private var text: String { acceptedScope == scope?.key ? frame?.text ?? "" : "" }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !text.isEmpty {
                if frame?.truncated == true { Text(friday: "较早的输出未显示").font(.caption).foregroundStyle(.secondary) }
                TaskCommandOutputText(text: text, dark: colorScheme == .dark).frame(height: outputHeight(TaskOutputText.plain(text)))
            } else if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            else if frame == nil { Text(friday: "正在加载输出…").font(.caption).foregroundStyle(.secondary) }
            else if frame?.running == false { Text(friday: "没有输出").font(.caption).foregroundStyle(.secondary) }
        }.task(id: (scope?.key ?? "") + ":" + String(store.connected)) {
            frame = nil; error = nil; acceptedScope = ""
            guard store.connected, let scope else { return }
            while !Task.isCancelled && currentOutputScope(scope, store) {
                do {
                    var request = try store.connection.request(scope.streamPath)
                    request.timeoutInterval = 30; request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw TaskOutputError.historyChanged }
                    var decoder = TaskOutputStream()
                    for try await line in bytes.lines {
                        guard !Task.isCancelled, currentOutputScope(scope, store) else { return }
                        if let value = try decoder.read(line) {
                            guard scope.accepts(value) else { throw TaskOutputError.historyChanged }
                            frame = value; error = nil; acceptedScope = scope.key
                            if !value.running { return }
                        }
                    }
                    throw TaskOutputError.missingFinalOutput
                } catch {
                    guard !Task.isCancelled, currentOutputScope(scope, store) else { return }
                    self.error = error.localizedDescription
                    if error as? TaskOutputError == .historyChanged { frame = nil; return }
                }
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
        }
    }
}

private func outputHeight(_ text: String, wraps: Bool = false) -> CGFloat {
    let lines = text.reduce(1) { $0 + ($1 == "\n" ? 1 : 0) }
    return CGFloat(min(320, max(36, (lines + (wraps ? text.count / 90 : 0)) * 19 + 8)))
}

#if os(macOS)
private typealias OutputColor = NSColor
private typealias OutputFont = NSFont
#else
private typealias OutputColor = UIColor
private typealias OutputFont = UIFont
#endif

private func outputColor(_ value: TaskOutputColor, dark: Bool) -> OutputColor {
    let rgb: (Int, Int, Int)
    switch value {
    case .rgb(let r, let g, let b): rgb = (r, g, b)
    case .indexed(let index):
        let palette = dark ? [0x3b4048, 0xf47067, 0x57ab5a, 0xc69026, 0x539bf5, 0xb083f0, 0x39c5cf, 0xadbac7, 0x768390, 0xff938a, 0x6bc46d, 0xdaaa3f, 0x6cb6ff, 0xdcbdfb, 0x56d4dd, 0xcdd9e5]
            : [0x24292f, 0xcf222e, 0x116329, 0x7d4e00, 0x0550ae, 0x8250df, 0x1b7c83, 0x6e7781, 0x57606a, 0xa40e26, 0x1a7f37, 0x633c01, 0x0969da, 0x6639ba, 0x3192aa, 0x8c959f]
        if (0..<16).contains(index) { let hex = palette[index]; rgb = (hex >> 16, (hex >> 8) & 255, hex & 255) }
        else if (16..<232).contains(index) { let n = index - 16; let level = [0, 95, 135, 175, 215, 255]; rgb = (level[n / 36], level[n / 6 % 6], level[n % 6]) }
        else { let level = min(255, max(0, 8 + (index - 232) * 10)); rgb = (level, level, level) }
    }
    return OutputColor(red: CGFloat(min(255, max(0, rgb.0))) / 255, green: CGFloat(min(255, max(0, rgb.1))) / 255, blue: CGFloat(min(255, max(0, rgb.2))) / 255, alpha: 1)
}
@MainActor private func outputAttributedText(_ text: String, dark: Bool) -> NSAttributedString {
    let value = NSMutableAttributedString(string: "")
    for span in TaskOutputText.spans(text) {
        let style = span.style
        var font = OutputFont.monospacedSystemFont(ofSize: 13, weight: style.bold ? .bold : .regular)
        #if os(macOS)
        if style.italic { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
        let foreground = style.foreground.map { outputColor($0, dark: dark) } ?? .labelColor
        let background = style.background.map { outputColor($0, dark: dark) } ?? .textBackgroundColor
        #else
        if style.italic, let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) { font = OutputFont(descriptor: descriptor, size: 13) }
        let foreground = style.foreground.map { outputColor($0, dark: dark) } ?? .label
        let background = style.background.map { outputColor($0, dark: dark) } ?? .systemBackground
        #endif
        var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: (style.inverse ? background : foreground).withAlphaComponent(style.dim ? 0.6 : 1)]
        if style.background != nil || style.inverse { attributes[.backgroundColor] = style.inverse ? foreground : background }
        if style.underline { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if style.strike { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        value.append(NSAttributedString(string: span.text, attributes: attributes))
    }
    return value
}

#if os(macOS)
private final class CommandOutputScroll: NSScrollView {
    let output = NSTextView(frame: .zero)
    override init(frame: NSRect) {
        super.init(frame: frame)
        drawsBackground = false; borderType = .noBorder; hasVerticalScroller = true; hasHorizontalScroller = true; autohidesScrollers = true
        output.isEditable = false; output.isSelectable = true; output.drawsBackground = false; output.usesFindBar = true
        output.isHorizontallyResizable = true; output.isVerticallyResizable = true; output.textContainerInset = NSSize(width: 2, height: 2)
        output.textContainer?.widthTracksTextView = false; output.textContainer?.containerSize = NSSize(width: 1_000_000, height: 1_000_000)
        documentView = output
    }
    required init?(coder: NSCoder) { nil }
    func setOutput(_ text: NSAttributedString) {
        guard output.textStorage?.isEqual(to: text) != true else { return }
        let follow = output.string.isEmpty || contentView.bounds.maxY >= output.frame.height - 8
        let selected = output.selectedRanges
        output.textStorage?.setAttributedString(text)
        if let container = output.textContainer { output.layoutManager?.ensureLayout(for: container) }
        let used = output.layoutManager?.usedRect(for: output.textContainer!).size ?? .zero
        output.setFrameSize(NSSize(width: max(contentSize.width, used.width + 4), height: max(contentSize.height, used.height + 4)))
        let valid = selected.filter { NSMaxRange($0.rangeValue) <= text.length }
        output.selectedRanges = valid.isEmpty ? [NSValue(range: NSRange(location: 0, length: 0))] : valid
        if follow { contentView.scroll(to: NSPoint(x: contentView.bounds.minX, y: max(0, output.frame.height - contentSize.height))); reflectScrolledClipView(contentView) }
    }
}
private struct TaskCommandOutputText: NSViewRepresentable {
    let text: String; let dark: Bool
    func makeNSView(context: Context) -> CommandOutputScroll { CommandOutputScroll(frame: .zero) }
    func updateNSView(_ view: CommandOutputScroll, context: Context) { view.setOutput(outputAttributedText(text, dark: dark)) }
}
#else
private struct TaskCommandOutputText: UIViewRepresentable {
    let text: String; let dark: Bool
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(); view.isEditable = false; view.isSelectable = true; view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 2, left: 2, bottom: 2, right: 2); view.textContainer.lineFragmentPadding = 0
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        let value = outputAttributedText(text, dark: dark)
        guard view.attributedText?.isEqual(to: value) != true else { return }
        let follow = view.text.isEmpty || view.contentOffset.y + view.bounds.height >= view.contentSize.height - 8
        let selected = view.selectedRange
        view.attributedText = value; view.layoutIfNeeded()
        if NSMaxRange(selected) <= value.length { view.selectedRange = selected }
        if follow { view.setContentOffset(CGPoint(x: 0, y: max(0, view.contentSize.height - view.bounds.height)), animated: false) }
    }
}
#endif
