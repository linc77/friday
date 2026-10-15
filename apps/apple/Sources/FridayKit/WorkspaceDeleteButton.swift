import SwiftUI

struct WorkspaceDeleteButton: View {
    @ObservedObject var store: FridayStore
    let project: Project
    @Binding var busy: Bool
    @Binding var error: String?
    let onDeleted: () -> Void
    @State private var confirming = false

    var body: some View {
        Button(role: .destructive) { confirming = true } label: {
            FridaySymbolLabel(friday: "删除 Workspace", systemImage: "trash")
                .font(.caption).foregroundStyle(.red)
        }
        .buttonStyle(FridaySymbolButtonStyle())
        .disabled(busy || !store.connected)
        .confirmationDialog(Text(friday: "删除 Workspace？"), isPresented: $confirming, titleVisibility: .visible) {
            Button(friday: "删除 Workspace", role: .destructive, action: delete)
            Button(friday: "取消", role: .cancel) {}
        } message: {
            Text(project.name) + Text("\n\n") + Text(friday: "目录文件和已有任务会保留。")
        }
    }

    private func delete() {
        guard !busy, store.connected else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await store.connection.data("/api/projects/\(project.id)", method: "DELETE")
                await store.refresh()
                onDeleted()
            } catch { self.error = error.localizedDescription }
        }
    }
}
