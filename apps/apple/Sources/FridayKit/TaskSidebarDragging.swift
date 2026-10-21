import SwiftUI
import UniformTypeIdentifiers

private let taskSidebarDragType = UTType(exportedAs: "dev.friday.task-sidebar-row", conformingTo: .data)

struct TaskSidebarDragSource: ViewModifier {
    let payload: TaskSidebarDragPayload?
    @ViewBuilder func body(content: Content) -> some View {
        if let payload, let data = try? JSONEncoder().encode(payload) {
            content.onDrag { NSItemProvider(item: data as NSData, typeIdentifier: taskSidebarDragType.identifier) }
        } else { content }
    }
}

struct TaskSidebarDropTarget: ViewModifier {
    let enabled: Bool
    let drop: (TaskSidebarDragPayload, Bool) -> Void
    @State private var height: CGFloat = 40
    @State private var after: Bool?

    @ViewBuilder func body(content: Content) -> some View {
        if enabled {
            content
                .background(GeometryReader { geometry in
                    Color.clear.onAppear { height = geometry.size.height }
                        .onChange(of: geometry.size.height) { _, value in height = value }
                })
                .overlay(alignment: after == true ? .bottom : .top) {
                    if after != nil { Rectangle().fill(Color.accentColor).frame(height: 2).allowsHitTesting(false) }
                }
                .onDrop(of: [taskSidebarDragType], delegate: TaskSidebarDropDelegate(height: height, hover: { after = $0 }, drop: drop))
                .onChange(of: enabled) { _, value in if !value { after = nil } }
        } else { content }
    }
}

private struct TaskSidebarDropDelegate: DropDelegate {
    let height: CGFloat
    let hover: (Bool?) -> Void
    let drop: (TaskSidebarDragPayload, Bool) -> Void
    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: [taskSidebarDragType]) }
    func dropEntered(info: DropInfo) { hover(info.location.y >= height / 2) }
    func dropUpdated(info: DropInfo) -> DropProposal? { hover(info.location.y >= height / 2); return DropProposal(operation: .move) }
    func dropExited(info: DropInfo) { hover(nil) }
    func performDrop(info: DropInfo) -> Bool {
        guard let provider = info.itemProviders(for: [taskSidebarDragType]).first else { return false }
        let after = info.location.y >= height / 2
        hover(nil)
        _ = provider.loadDataRepresentation(forTypeIdentifier: taskSidebarDragType.identifier) { data, _ in
            guard let data, data.count <= 8192, let payload = try? JSONDecoder().decode(TaskSidebarDragPayload.self, from: data) else { return }
            Task { @MainActor in drop(payload, after) }
        }
        return true
    }
}
