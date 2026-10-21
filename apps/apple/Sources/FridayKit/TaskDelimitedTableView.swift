import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct TaskDelimitedTableView: View {
    let name: String; let text: String; let delimiter: UInt16
    @State private var table: TaskDelimitedTable?
    @State private var parsedText: String?
    @State private var parsedDelimiter: UInt16?
    private var request: String { String(delimiter) + ":" + text }
    var body: some View {
        VStack(spacing: 0) {
            if let table, parsedText == text, parsedDelimiter == delimiter {
                if table.truncated { Text(friday: "表格预览已截取：最多 100 行、30 列，每格 2000 字符。可切换源码查看完整内容。").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(10) }
                GeometryReader { geometry in
                    let widths = columnWidths(table, available: geometry.size.width)
                    ScrollView([.horizontal, .vertical]) {
                        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                            Section {
                                ForEach(Array(table.rows.dropFirst().enumerated()), id: \.offset) { index, row in
                                    cells(row, widths: widths, header: false).background(index.isMultiple(of: 2) ? Color.clear : Color.primary.opacity(0.025))
                                }
                            } header: { if let header = table.rows.first { cells(header, widths: widths, header: true).background { FridayTheme.canvas.overlay { Color.primary.opacity(0.045) } }.zIndex(1) } }
                        }.frame(minWidth: geometry.size.width, alignment: .leading)
                    }.accessibilityElement(children: .contain).accessibilityLabel(Text(verbatim: name))
                }
            } else { ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .task(id: request) {
                let source = text, separator = delimiter
                let parsing = Task.detached(priority: .userInitiated) { TaskDelimitedTable.parse(source, delimiter: separator) }
                let value = await withTaskCancellationHandler(operation: { await parsing.value }, onCancel: { parsing.cancel() })
                if !Task.isCancelled { table = value; parsedText = source; parsedDelimiter = separator }
            }
    }
    private func columnWidths(_ table: TaskDelimitedTable, available: CGFloat) -> [CGFloat] {
        let count = table.rows.map(\.count).max() ?? 0; guard count > 0 else { return [] }; var widths = Array(repeating: CGFloat(80), count: count)
        #if os(macOS)
        let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        #else
        let font = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        #endif
        for row in table.rows { for (index, cell) in row.enumerated() {
            let longest = cell.split(whereSeparator: { $0 == "\n" || $0 == "\r" }).map { (String($0) as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
            widths[index] = max(widths[index], min(320, longest + 24))
        } }
        let extra = max(0, available - widths.reduce(0, +)) / CGFloat(count); return widths.map { $0 + extra }
    }
    private func cells(_ row: [String], widths: [CGFloat], header: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
                Text(verbatim: cell).font(.system(size: 12, weight: header ? .medium : .regular)).monospacedDigit().textSelection(.enabled)
                    .frame(width: max(1, min(296, widths[index] - 24)), alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    .frame(width: max(1, widths[index] - 24), alignment: .leading).padding(.horizontal, 12).padding(.vertical, 6)
            }
        }.frame(width: widths.reduce(0, +), alignment: .leading)
            .overlay(alignment: .bottom) { Rectangle().fill(.primary.opacity(header ? 0.14 : 0.07)).frame(height: 0.5) }
    }
}
