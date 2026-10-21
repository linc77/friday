import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct TaskFileTreeMenuItem {
    let title: String; let symbol: String
    var enabled = true
    var children: [TaskFileTreeMenuItem] = []
    var action: () -> Void = {}
}
struct TaskFileBrowserTree: View {
    let entries: [String: [TaskFileEntry]]
    let matches: [TaskFileEntry]
    let query: String
    let expanded: Set<String>
    let selected: String?
    let reveal: String
    let scope: String
    var mentionRoot: String? = nil
    let open: (String) -> Void
    let toggle: (TaskFileTreeItem, Bool) -> Void
    let menu: (TaskFileEntry) -> [TaskFileTreeMenuItem]
    let clearSearch: () -> Void
    let copyMentions: ([TaskFileEntry]) -> Void
    @State private var projection = TaskFileTreeProjection()
    @State private var search = TaskFileTreeSearchState()
    private struct Input: Equatable { let entries: [String: [TaskFileEntry]]; let matches: [TaskFileEntry]; let query: String }
    var body: some View {
        TaskFileTreeNative(projection: projection, expanded: search.expanded(projection, workspace: expanded), selected: selected, reveal: reveal, scope: scope, mentionRoot: mentionRoot,
            open: open, toggle: { item, value in if projection.searching { search.toggle(item, expanded: value) } else { toggle(item, value) } }, menu: menu, clearSearch: clearSearch, copyMentions: copyMentions)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onChange(of: Input(entries: entries, matches: matches, query: TaskFileTreeSearch.normalize(query)), initial: true) { _, value in
                let next = TaskFileTreeProjection(entries: value.entries, matches: value.matches, query: value.query); search.observe(value.query); projection = next
                func restoreChains(_ items: [TaskFileTreeItem]) {
                    for item in items where item.directory && item.expanded(in: expanded) {
                        if !Set(item.chain).isSubset(of: expanded) { toggle(item, true) }; restoreChains(item.children)
                    }
                }
                if !next.searching { restoreChains(next.roots) }
            }
    }
}
private struct FileTreeCell: View {
    let item: TaskFileTreeItem; var depth = 0; var expanded = false; var mobile = false; var activation = 0
    var body: some View {
        HStack(spacing: 7) {
            if mobile { FridaySymbolImage(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 9)).frame(width: 10).opacity(item.directory ? 1 : 0) }
            FridaySymbolImage(systemName: item.entry.symbol).foregroundStyle(.secondary).frame(width: 14)
            Text(verbatim: item.title).lineLimit(1).truncationMode(.middle).foregroundStyle(item.entry.ignored == true ? Color.secondary : Color.primary)
            Spacer(minLength: 0)
        }.font(.caption).padding(.leading, mobile ? CGFloat(depth) * 14 + 6 : 2).padding(.trailing, 7).padding(.vertical, 5)
            .fridaySymbolFeedback(value: activation)
    }
}

#if os(macOS)
private final class OutlineFileNode: NSObject {
    let item: TaskFileTreeItem; let children: [OutlineFileNode]
    init(_ item: TaskFileTreeItem) { self.item = item; children = item.children.map(OutlineFileNode.init) }
}
private final class FileOutlineView: NSOutlineView {
    var mouseBegan: (() -> Void)?; var mouseEnded: (() -> Void)?; var keyboardBegan: (() -> Void)?
    var buildMenu: ((NSEvent) -> NSMenu?)?; var copySelection: (() -> Void)?; var escape: (() -> Void)?
    override func mouseDown(with event: NSEvent) { mouseBegan?(); super.mouseDown(with: event); mouseEnded?() }
    override func keyDown(with event: NSEvent) {
        keyboardBegan?()
        if event.keyCode == 53 { escape?(); return }; super.keyDown(with: event)
    }
    override func menu(for event: NSEvent) -> NSMenu? { buildMenu?(event) }
    @objc func copy(_ sender: Any?) { copySelection?() }
    override func resetCursorRects() {
        super.resetCursorRects(); let visible = rows(in: visibleRect)
        if visible.location != NSNotFound { for row in visible.location..<NSMaxRange(visible) { addCursorRect(rect(ofRow: row), cursor: .pointingHand) } }
    }
}
private struct TaskFileTreeNative: NSViewRepresentable {
    let projection: TaskFileTreeProjection; let expanded: Set<String>; let selected: String?; let reveal: String; let scope: String
    let mentionRoot: String?
    let open: (String) -> Void; let toggle: (TaskFileTreeItem, Bool) -> Void; let menu: (TaskFileEntry) -> [TaskFileTreeMenuItem]
    let clearSearch: () -> Void; let copyMentions: ([TaskFileEntry]) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView(), outline = FileOutlineView(), column = NSTableColumn(identifier: .init("file"))
        column.isEditable = false; outline.addTableColumn(column); outline.outlineTableColumn = column; outline.headerView = nil
        outline.rowHeight = 28; outline.intercellSpacing = .zero; outline.indentationPerLevel = 14; outline.backgroundColor = .clear
        outline.allowsMultipleSelection = true; outline.allowsEmptySelection = true; outline.dataSource = context.coordinator; outline.delegate = context.coordinator
        outline.setDraggingSourceOperationMask(.copy, forLocal: true); outline.setDraggingSourceOperationMask(.copy, forLocal: false)
        outline.registerForDraggedTypes([TaskFileMentionTransfer.pasteboardType]); outline.setAccessibilityLabel(String(localized: "工作区文件", bundle: .module))
        scroll.documentView = outline; scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = false; scroll.drawsBackground = false
        let coordinator = context.coordinator
        outline.mouseBegan = { [weak coordinator] in guard let coordinator else { return }; coordinator.revealState.interacted(coordinator.parent.reveal); coordinator.interaction.beginMouse() }
        outline.mouseEnded = { [weak coordinator, weak outline] in
            guard let coordinator else { return }; if let path = coordinator.interaction.endMouse() { coordinator.parent.open(path) }
            if let outline { coordinator.animateSelection(outline) }
        }
        outline.keyboardBegan = { [weak coordinator] in guard let coordinator else { return }; coordinator.revealState.interacted(coordinator.parent.reveal); coordinator.interaction.beginKeyboard() }
        outline.copySelection = { [weak coordinator] in guard let coordinator else { return }; coordinator.parent.copyMentions(coordinator.interaction.selected) }
        outline.escape = { [weak coordinator] in coordinator?.parent.clearSearch() }
        outline.buildMenu = { [weak coordinator, weak outline] event in guard let coordinator, let outline else { return nil }; return coordinator.contextMenu(outline, event: event) }
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let outline = scroll.documentView as? FileOutlineView else { return }; let coordinator = context.coordinator
        let changed = !coordinator.loaded || coordinator.parent.projection != projection; coordinator.parent = self; coordinator.updating = true; coordinator.loaded = true
        if changed { coordinator.roots = projection.roots.map(OutlineFileNode.init); outline.reloadData() }
        func restore(_ nodes: [OutlineFileNode]) {
            for node in nodes where node.item.directory {
                let value = node.item.expanded(in: expanded)
                if value != outline.isItemExpanded(node) { if value { outline.expandItem(node) } else { outline.collapseItem(node) } }
                if value { restore(node.children) }
            }
        }
        restore(coordinator.roots)
        let revealing = coordinator.revealState.pending(reveal)
        let paths = revealing ? Set(selected.map { [$0] } ?? []) : Set(coordinator.interaction.selected.map(\.path))
        var indexes = IndexSet()
        for row in 0..<outline.numberOfRows { if let node = outline.item(atRow: row) as? OutlineFileNode, paths.contains(node.item.path) || revealing && node.item.chain.contains(where: paths.contains) { indexes.insert(row) } }
        if outline.selectedRowIndexes != indexes { outline.selectRowIndexes(indexes, byExtendingSelection: false) }
        _ = coordinator.interaction.select(coordinator.selectedEntries(outline))
        if revealing, let row = indexes.first { outline.scrollRowToVisible(row) }
        if revealing { coordinator.revealState.resolve(reveal, selected: selected, found: !indexes.isEmpty) }
        coordinator.updating = false
    }
    final class Coordinator: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
        var parent: TaskFileTreeNative; var roots: [OutlineFileNode] = []; var updating = false, loaded = false; var revealState = TaskFileTreeReveal()
        var interaction = TaskFileTreeInteraction(), pulses: [String: Int] = [:], menuActions: [Int: () -> Void] = [:]
        init(_ parent: TaskFileTreeNative) { self.parent = parent; roots = parent.projection.roots.map(OutlineFileNode.init) }
        func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { (item as? OutlineFileNode)?.children.count ?? roots.count }
        func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { ((item as? OutlineFileNode)?.children ?? roots)[index] }
        func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { (item as? OutlineFileNode)?.item.directory == true }
        func outlineView(_ outlineView: NSOutlineView, objectValueFor tableColumn: NSTableColumn?, byItem item: Any?) -> Any? { (item as? OutlineFileNode)?.item.title }
        func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
            guard let node = item as? OutlineFileNode else { return nil }
            let host = NSHostingView(rootView: FileTreeCell(item: node.item, activation: pulses[node.item.path] ?? 0)); host.setAccessibilityElement(false); return host
        }
        func selectedEntries(_ outline: NSOutlineView) -> [TaskFileEntry] { outline.selectedRowIndexes.compactMap { (outline.item(atRow: $0) as? OutlineFileNode)?.item.entry } }
        func outlineViewSelectionDidChange(_ notification: Notification) {
            guard !updating, let outline = notification.object as? NSOutlineView else { return }
            if let path = interaction.select(selectedEntries(outline)) { parent.open(path) }
        }
        func animateSelection(_ outline: NSOutlineView) {
            for row in outline.selectedRowIndexes {
                guard let node = outline.item(atRow: row) as? OutlineFileNode else { continue }; pulses[node.item.path, default: 0] += 1
                if let host = outline.view(atColumn: 0, row: row, makeIfNecessary: false) as? NSHostingView<FileTreeCell> { host.rootView = FileTreeCell(item: node.item, activation: pulses[node.item.path] ?? 0) }
            }
        }
        func outlineViewItemWillExpand(_ notification: Notification) { expansion(notification, true) }
        func outlineViewItemDidCollapse(_ notification: Notification) { expansion(notification, false) }
        func expansion(_ notification: Notification, _ value: Bool) { guard !updating, let node = notification.userInfo?["NSObject"] as? OutlineFileNode else { return }; parent.toggle(node.item, value) }
        func outlineView(_ outlineView: NSOutlineView, pasteboardWriterForItem item: Any) -> NSPasteboardWriting? {
            guard let node = item as? OutlineFileNode, TaskFileMention(node.item.entry).valid else { return nil }
            let entry = parent.mentionRoot.map { TaskHostPath.entry(node.item.entry, root: $0) } ?? node.item.entry
            let payload = TaskFileMentionPayload(scope: parent.scope, entries: [TaskFileMention(entry)]), writer = NSPasteboardItem()
            guard let data = payload.data else { return nil }; writer.setData(data, forType: TaskFileMentionTransfer.pasteboardType); return writer
        }
        func outlineView(_ outlineView: NSOutlineView, draggingSession session: NSDraggingSession, willBeginAt screenPoint: NSPoint, forItems draggedItems: [Any]) { interaction.beginDrag() }
        func outlineView(_ outlineView: NSOutlineView, draggingSession session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) { interaction.endDrag(); updating = true; outlineView.deselectAll(nil); updating = false }
        func outlineView(_ outlineView: NSOutlineView, validateDrop info: NSDraggingInfo, proposedItem item: Any?, proposedChildIndex index: Int) -> NSDragOperation { [] }
        func contextMenu(_ outline: NSOutlineView, event: NSEvent) -> NSMenu? {
            let row = outline.row(at: outline.convert(event.locationInWindow, from: nil)); guard row >= 0, let node = outline.item(atRow: row) as? OutlineFileNode else { return nil }
            let result = NSMenu(); menuActions = [:]
            func append(_ actions: [TaskFileTreeMenuItem], to menu: NSMenu) {
                menu.autoenablesItems = false
                for action in actions {
                    let item = NSMenuItem(title: action.title, action: action.children.isEmpty ? #selector(activate(_:)) : nil, keyEquivalent: "")
                    item.target = self; item.isEnabled = action.enabled; item.image = NSImage(systemSymbolName: action.symbol, accessibilityDescription: nil)
                    if action.children.isEmpty { item.tag = menuActions.count; menuActions[item.tag] = action.action }
                    else { let submenu = NSMenu(); append(action.children, to: submenu); item.submenu = submenu }
                    menu.addItem(item)
                }
            }
            append(parent.menu(node.item.entry), to: result)
            result.autoenablesItems = false; return result
        }
        @objc func activate(_ sender: NSMenuItem) { menuActions[sender.tag]?() }
    }
}
#else
private struct TaskFileTreeNative: UIViewRepresentable {
    let projection: TaskFileTreeProjection; let expanded: Set<String>; let selected: String?; let reveal: String; let scope: String
    let mentionRoot: String?
    let open: (String) -> Void; let toggle: (TaskFileTreeItem, Bool) -> Void; let menu: (TaskFileEntry) -> [TaskFileTreeMenuItem]
    let clearSearch: () -> Void; let copyMentions: ([TaskFileEntry]) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UITableView {
        let table = UITableView(frame: .zero, style: .plain); table.backgroundColor = .clear; table.separatorStyle = .none
        table.delegate = context.coordinator; table.dataSource = context.coordinator; table.dragDelegate = context.coordinator
        table.dragInteractionEnabled = true; table.allowsMultipleSelection = true; table.allowsMultipleSelectionDuringEditing = true; table.rowHeight = UITableView.automaticDimension; table.estimatedRowHeight = 30
        table.accessibilityLabel = String(localized: "工作区文件", bundle: .module); return table
    }
    func updateUIView(_ table: UITableView, context: Context) {
        let saved = context.coordinator, changed = !saved.loaded || saved.parent.projection != projection || saved.parent.expanded != expanded
        let selectedPaths = Set((table.indexPathsForSelectedRows ?? []).compactMap { saved.rows.indices.contains($0.row) ? saved.rows[$0.row].item.path : nil })
        saved.parent = self; saved.loaded = true
        if changed { saved.rows = projection.visible(expanded: expanded); table.reloadData() }
        let revealing = saved.revealState.pending(reveal)
        if changed || revealing { for index in table.indexPathsForSelectedRows ?? [] { table.deselectRow(at: index, animated: false) } }
        if revealing {
            let index = saved.rows.firstIndex(where: { item in selected.map { item.item.chain.contains($0) } == true })
            if let index { table.selectRow(at: IndexPath(row: index, section: 0), animated: false, scrollPosition: .middle) }
            saved.revealState.resolve(reveal, selected: selected, found: index != nil)
        } else if changed {
            for (index, row) in saved.rows.enumerated() where selectedPaths.contains(row.item.path) { table.selectRow(at: IndexPath(row: index, section: 0), animated: false, scrollPosition: .none) }
        }
    }
    final class Coordinator: NSObject, UITableViewDataSource, UITableViewDelegate, UITableViewDragDelegate {
        var parent: TaskFileTreeNative, rows: [(item: TaskFileTreeItem, depth: Int)] = []
        var revealState = TaskFileTreeReveal(), dragging = false, loaded = false, pulses: [String: Int] = [:]
        init(_ parent: TaskFileTreeNative) { self.parent = parent; rows = parent.projection.visible(expanded: parent.expanded) }
        func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }
        func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
            let cell = tableView.dequeueReusableCell(withIdentifier: "file") ?? UITableViewCell(style: .default, reuseIdentifier: "file"), row = rows[indexPath.row]
            let pulse = pulses[row.item.path] ?? 0
            cell.backgroundColor = .clear; cell.contentConfiguration = UIHostingConfiguration { FileTreeCell(item: row.item, depth: row.depth, expanded: row.item.expanded(in: self.parent.expanded), mobile: true, activation: pulse) }.margins(.all, 0)
            return cell
        }
        func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
            activate(tableView, at: indexPath)
        }
        func tableView(_ tableView: UITableView, willDeselectRowAt indexPath: IndexPath) -> IndexPath? {
            guard !dragging, !tableView.isEditing else { return indexPath }; activate(tableView, at: indexPath); return nil
        }
        func activate(_ tableView: UITableView, at indexPath: IndexPath) {
            guard !dragging, rows.indices.contains(indexPath.row) else { return }; let item = rows[indexPath.row].item
            revealState.interacted(parent.reveal)
            if !tableView.isEditing { for other in tableView.indexPathsForSelectedRows ?? [] where other != indexPath { tableView.deselectRow(at: other, animated: false) } }
            pulses[item.path, default: 0] += 1
            if let cell = tableView.cellForRow(at: indexPath) {
                let row = rows[indexPath.row], pulse = pulses[item.path] ?? 0
                cell.contentConfiguration = UIHostingConfiguration { FileTreeCell(item: row.item, depth: row.depth, expanded: row.item.expanded(in: self.parent.expanded), mobile: true, activation: pulse) }.margins(.all, 0)
            }
            if item.directory { parent.toggle(item, !item.expanded(in: parent.expanded)) } else if parent.selected != item.path { parent.open(item.path) }
        }
        func tableView(_ tableView: UITableView, shouldBeginMultipleSelectionInteractionAt indexPath: IndexPath) -> Bool { true }
        func tableViewDidEndMultipleSelectionInteraction(_ tableView: UITableView) { tableView.setEditing(false, animated: false) }
        func tableView(_ tableView: UITableView, itemsForBeginning session: UIDragSession, at indexPath: IndexPath) -> [UIDragItem] {
            dragging = true
            revealState.interacted(parent.reveal)
            let selection = tableView.indexPathsForSelectedRows ?? [], paths = selection.contains(indexPath) ? selection.sorted() : [indexPath]
            let payload = TaskFileMentionPayload(scope: parent.scope, entries: paths.map { let entry = rows[$0.row].item.entry; return TaskFileMention(parent.mentionRoot.map { TaskHostPath.entry(entry, root: $0) } ?? entry) })
            return [UIDragItem(itemProvider: TaskFileMentionTransfer.provider(payload))]
        }
        func tableView(_ tableView: UITableView, dragSessionDidEnd session: UIDragSession) { dragging = false; tableView.setEditing(false, animated: false); for index in tableView.indexPathsForSelectedRows ?? [] { tableView.deselectRow(at: index, animated: false) } }
        func tableView(_ tableView: UITableView, contextMenuConfigurationForRowAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
            let entry = rows[indexPath.row].item.entry
            return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
                guard let self else { return UIMenu(children: []) }
                func element(_ item: TaskFileTreeMenuItem) -> UIMenuElement {
                    if !item.children.isEmpty, item.enabled { return UIMenu(title: item.title, image: UIImage(systemName: item.symbol), children: item.children.map(element)) }
                    return UIAction(title: item.title, image: UIImage(systemName: item.symbol), attributes: item.enabled ? [] : .disabled) { _ in item.action() }
                }
                return UIMenu(children: self.parent.menu(entry).map(element))
            }
        }
    }
}
#endif
