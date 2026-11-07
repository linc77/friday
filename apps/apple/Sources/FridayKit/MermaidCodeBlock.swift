import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct MermaidCodeBlock: View {
    let fence: MarkdownFence
    let isStreaming: Bool
    @Environment(\.colorScheme) private var colorScheme
    @State private var showCode = false
    @State private var wrapped = true
    private struct Selection: Identifiable { let id = UUID(); let diagram: MermaidDiagram }
    @State private var selected: Selection? = nil
    @State private var width: CGFloat = 640
    @State private var result: MermaidResult? = nil
    @State private var resultKey: MermaidRequest? = nil
    @State private var attempt = 0
    @State private var retryRequest: MermaidRequest? = nil
    @State private var copied = false
    @State private var copyID = UUID()
    private struct Load: Hashable { let key: MermaidRequest; let streaming: Bool; let sourceVisible: Bool; let attempt: Int }
    private var request: MermaidRequest { MermaidRequest(source: fence.text, dark: colorScheme == .dark) }
    private var showDiagram: Bool { !showCode && !isStreaming && !request.source.isEmpty }
    var body: some View {
        Group {
            if showDiagram {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 14) {
                        Spacer(); toggle
                        copySource
                    }.font(.caption).foregroundStyle(.secondary)
                    if resultKey == request, let result {
                        switch result {
                        case .rendered(let diagram):
                            ZStack {
                                MermaidSVGView(diagram: diagram, failure: { message in self.result = .failure(message, retryable: true) })
                                    .allowsHitTesting(false).accessibilityHidden(true)
                                Button { selected = Selection(diagram: diagram) } label: { Color.clear.contentShape(Rectangle()) }
                                    .buttonStyle(.plain).fridayInteractiveCursor().accessibilityLabel(Text(friday: "展开图表"))
                            }.frame(height: max(24, diagram.displayHeight(availableWidth: width)))
                        case .failure(let message, let retryable):
                            HStack(alignment: .top, spacing: 10) {
                                Text(friday: "无法绘制图表").foregroundStyle(.orange)
                                Text(fridayString: message).foregroundStyle(.secondary).textSelection(.enabled)
                                if retryable { Button(friday: "重试") { retryRequest = request; attempt += 1 }.buttonStyle(FridaySymbolButtonStyle()) }
                            }.font(.caption)
                            Text(verbatim: fence.text).font(.system(.callout, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    } else {
                        HStack(spacing: 8) { ProgressView().controlSize(.small); Text(friday: "正在绘制图表").font(.caption).foregroundStyle(.secondary) }
                            .frame(maxWidth: .infinity, minHeight: 144)
                    }
                }
            } else {
                AgentCodeBlock(language: fence.language, text: fence.text, title: fence.title, headerActions: isStreaming ? nil : AnyView(toggle), copyControl: AnyView(copySource), wrapping: $wrapped)
            }
        }.background(GeometryReader { proxy in Color.clear.preference(key: MermaidWidth.self, value: proxy.size.width) })
            .sheet(item: $selected) { selection in MermaidExpandedView(diagram: selection.diagram) }
            .onPreferenceChange(MermaidWidth.self) { value in if value > 0 && value.isFinite && abs(width - value) > 0.5 { width = value } }
            .task(id: Load(key: request, streaming: isStreaming, sourceVisible: showCode, attempt: attempt)) {
                guard showDiagram else { return }; let key = request
                let retry = retryRequest == key; retryRequest = nil
                if retry { result = nil; resultKey = nil }
                let value = await MermaidRenderer.shared.render(source: key.source, dark: key.dark, retry: retry)
                guard !Task.isCancelled, key == request else { return }; result = value; resultKey = key
            }.task(id: copyID) {
                guard copied else { return }; try? await Task.sleep(for: .milliseconds(1200)); if !Task.isCancelled { copied = false }
            }
    }
    private var toggle: some View {
        Button { showCode.toggle() } label: { FridaySymbolImage(systemName: showCode ? "point.3.connected.trianglepath.dotted" : "chevron.left.forwardslash.chevron.right") }
            .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: showCode ? "查看图表" : "查看源码"))
            .help(Text(friday: showCode ? "查看图表" : "查看源码"))
    }
    private var copySource: some View {
        Button { copyAgentText(fence.text); copied = true; copyID = UUID() } label: { FridaySymbolImage(systemName: copied ? "checkmark" : "doc.on.doc") }
            .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: copied ? "已复制" : "复制代码"))
    }
}
private struct MermaidWidth: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct MermaidSVGDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.svg] }
    let data: Data
    init(svg: String) { data = Data(svg.utf8) }
    init(configuration: ReadConfiguration) throws { guard let data = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }; self.data = data }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
private struct MermaidExpandedView: View {
    let diagram: MermaidDiagram
    @Environment(\.dismiss) private var dismiss
    @State private var zoom = 1.0
    @State private var exporting = false
    @State private var copying = false
    @State private var copied = false
    @State private var copyID = UUID()
    @State private var error: String? = nil
    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 16) {
                Button { zoom = max(0.25, zoom / 1.25) } label: { FridaySymbolImage(systemName: "minus.magnifyingglass") }.disabled(zoom <= 0.25).help(Text(friday: "缩小")).accessibilityLabel(Text(friday: "缩小"))
                Button { zoom = 1 } label: { Text(verbatim: "\(Int(zoom * 100))%") }.help(Text(friday: "适合窗口")).accessibilityLabel(Text(friday: "适合窗口")).accessibilityValue(Text(verbatim: "\(Int(zoom * 100))%"))
                Button { zoom = min(8, zoom * 1.25) } label: { FridaySymbolImage(systemName: "plus.magnifyingglass") }.disabled(zoom >= 8).help(Text(friday: "放大")).accessibilityLabel(Text(friday: "放大"))
                Spacer()
                Button(action: copyImage) { FridaySymbolImage(systemName: copied ? "checkmark" : "doc.on.doc") }.disabled(copying).help(Text(friday: copied ? "已复制" : "复制图表图片")).accessibilityLabel(Text(friday: copied ? "已复制" : "复制图表图片"))
                Button { exporting = true } label: { FridaySymbolImage(systemName: "square.and.arrow.down") }.help(Text(friday: "导出 SVG")).accessibilityLabel(Text(friday: "导出 SVG"))
                Button { dismiss() } label: { FridaySymbolImage(systemName: "xmark") }.help(Text(friday: "关闭")).keyboardShortcut(.cancelAction).accessibilityLabel(Text(friday: "关闭"))
            }.buttonStyle(FridaySymbolButtonStyle()).font(.callout)
            MermaidSVGView(diagram: diagram, expanded: true, zoom: $zoom, failure: { error = $0 }).frame(maxWidth: .infinity, maxHeight: .infinity)
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        }.padding(16)
            #if os(macOS)
            .frame(minWidth: 340, idealWidth: 1000, minHeight: 300, idealHeight: 720)
            #else
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            #endif
            .fileExporter(isPresented: $exporting, document: MermaidSVGDocument(svg: diagram.svg), contentType: .svg, defaultFilename: "Mermaid diagram") { result in if case .failure = result { error = "图表导出失败，请重试" } }
            .task(id: copyID) { guard copied else { return }; try? await Task.sleep(for: .milliseconds(1200)); if !Task.isCancelled { copied = false } }
    }
    private func copyImage() {
        guard !copying else { return }; copying = true; error = nil
        Task { @MainActor in
            defer { copying = false }
            guard let png = await MermaidRenderer.shared.png(diagram) else { error = "复制图表失败，请重试"; return }
            #if os(macOS)
            let item = NSPasteboardItem(); item.setData(png, forType: .png); item.setData(Data(diagram.svg.utf8), forType: NSPasteboard.PasteboardType(UTType.svg.identifier))
            NSPasteboard.general.clearContents(); guard NSPasteboard.general.writeObjects([item]) else { error = "复制图表失败，请重试"; return }
            #else
            UIPasteboard.general.setItems([[UTType.png.identifier: png, UTType.svg.identifier: Data(diagram.svg.utf8)]])
            #endif
            copied = true; copyID = UUID()
        }
    }
}
