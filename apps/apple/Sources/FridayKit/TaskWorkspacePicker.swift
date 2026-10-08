import SwiftUI

@MainActor
final class TaskWorkspaceState: ObservableObject {
    @Published var options: TaskWorkspaceOptions?
    @Published var error: String?
    @Published var loading = false
    private var path: String?
    private var generation = UUID()

    func options(for path: String) -> TaskWorkspaceOptions? { self.path == path ? options : nil }
    func isReady(for path: String) -> Bool { self.path == path && options != nil && error == nil && !loading }

    func refresh(store: FridayStore, path: String) async {
        let request = UUID(); generation = request
        if self.path != path { options = nil; error = nil; self.path = path }
        guard store.connected else { loading = false; return }
        loading = true
        defer { if generation == request { loading = false } }
        do {
            let value = try await store.connection.decode(TaskWorkspaceOptions.self, path)
            guard !Task.isCancelled, generation == request else { return }
            options = value; error = nil
        } catch {
            guard !Task.isCancelled, generation == request else { return }
            self.error = error.localizedDescription
        }
    }
}

/// Only the new conversation welcome area offers an execution location.
struct TaskExecutionLocationPicker: View {
    @Binding var selection: TaskWorkspaceSelection
    let options: TaskWorkspaceOptions?

    var body: some View {
        HStack(spacing: 8) {
            choice("checkout", title: "当前工作区")
            choice("worktree", title: "New Worktree")
        }
        .padding(5).background(FridayTheme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.primary.opacity(0.10), lineWidth: 1))
        .fixedSize(horizontal: false, vertical: true).frame(maxWidth: 360)
        .accessibilityElement(children: .contain).accessibilityLabel(Text(friday: "执行位置"))
    }

    private func choice(_ mode: String, title: String) -> some View {
        Button { selection.selectMode(mode) } label: {
            HStack(spacing: 8) {
                if mode == "worktree" {
                    WorktreeIcon().accessibilityHidden(true)
                } else {
                    FridaySymbolImage(systemName: "folder")
                }
                Text(fridayString: title).lineLimit(1)
            }
            .font(.callout.weight(.medium)).frame(maxWidth: .infinity).padding(.vertical, 11)
            .foregroundStyle(selection.mode == mode ? Color.primary : .secondary)
            .background(selection.mode == mode ? Color.primary.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
        }
        .buttonStyle(FridaySymbolButtonStyle())
        .disabled(mode == "worktree" && options?.hasCommit != true)
        .accessibilityAddTraits(selection.mode == mode ? .isSelected : [])
        .help(Text(friday: mode == "worktree" ? "从所选分支创建独立工作区，不包含未提交改动。" : "在当前目录执行，发送任务后切换到所选分支。"))
    }
}

struct NewTaskBranchControl: View {
    @ObservedObject var store: FridayStore
    @ObservedObject var state: TaskWorkspaceState
    let projectId: String
    @Binding var selection: TaskWorkspaceSelection
    @State private var presented = false
    @Environment(\.locale) private var locale

    var body: some View {
        BranchControlLabel(name: state.loading && state.options == nil ? "读取分支…" : selection.branchName(in: state.options)) { presented.toggle() }
            .popover(isPresented: $presented) {
                TaskBranchPicker(options: state.options, selected: selection.branch, error: state.error,
                    loading: state.loading, allowsRemote: selection.mode == "worktree", includesCurrent: true,
                    refresh: { Task { await refresh() } }, select: { selection.branch = $0; presented = false })
                    .environment(\.locale, locale).task { await refresh() }
            }
    }
    private func refresh() async { await state.refresh(store: store, path: "/api/projects/\(projectId)/git") }
}

struct ExistingTaskBranchControl: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    @Binding var submitting: Bool
    @StateObject private var state = TaskWorkspaceState()
    @State private var presented = false
    @State private var error: String?
    @Environment(\.locale) private var locale
    private var busy: Bool { submitting || task.branchChange?.active == true }

    var body: some View {
        BranchControlLabel(name: TaskRowPresentation.branch(task.git ?? state.options?.git)) { presented.toggle() }
            .help(Text(friday: "切换分支"))
            .popover(isPresented: $presented) {
                TaskBranchPicker(options: state.options,
                    selected: state.options?.git.branch.map { "refs/heads/" + $0 },
                    error: error ?? state.error ?? task.branchChange?.error,
                    loading: state.loading, allowsRemote: false, includesCurrent: false,
                    blocked: task.active || busy || !store.connected,
                    note: busy ? "正在切换分支…" : task.active ? "任务执行完成后可以切换分支。" : "切换当前目录的分支，继续使用这个会话。",
                    refresh: { Task { await refresh() } }, select: { branch in if let branch { switchBranch(branch) } })
                    .environment(\.locale, locale).task { await refresh() }
            }
            .task(id: task.branchChange?.status) {
                await refresh()
                if task.branchChange?.status == "completed" { presented = false; error = nil }
            }
    }

    private func refresh() async { await state.refresh(store: store, path: "/api/tasks/\(task.id)/git") }
    private func switchBranch(_ branch: String) {
        guard !task.active, !busy, store.connected else { return }
        submitting = true; error = nil
        Task {
            defer { submitting = false }
            do {
                _ = try await store.connection.decode(IDResponse.self, "/api/tasks/\(task.id)/branch", method: "POST",
                    body: ["branch": branch, "requestId": UUID().uuidString])
                await store.refresh()
            } catch { self.error = error.localizedDescription }
        }
    }
}

private struct BranchControlLabel: View {
    let name: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                FridaySymbolImage(systemName: "arrow.triangle.branch")
                Text(fridayString: name).lineLimit(1).truncationMode(.middle)
            }
        }.buttonStyle(FridaySymbolButtonStyle())
            .accessibilityLabel(Text(friday: "切换分支")).accessibilityValue(Text(name))
    }
}

/// Shared branch-only panel. Execution location never appears in this popover.
struct TaskBranchPicker: View {
    let options: TaskWorkspaceOptions?
    let selected: String?
    let error: String?
    let loading: Bool
    let allowsRemote: Bool
    let includesCurrent: Bool
    var blocked = false
    var note: String? = nil
    let refresh: () -> Void
    let select: (String?) -> Void
    @State private var search = ""

    private var branches: [TaskWorkspaceOptions.Branch] {
        options?.branches.filter { (allowsRemote || !$0.remote) && (search.isEmpty || $0.name.localizedStandardContains(search)) } ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(friday: "切换分支").font(.headline)
                Spacer()
                TaskBranchRefreshButton(action: refresh).disabled(loading)
            }.padding(16)
            if let note { Text(fridayString: note).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 16).padding(.bottom, 12) }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).padding(.horizontal, 16).padding(.bottom, 12) }
            Divider()
            if let options, options.git.status == "repository" {
                HStack(spacing: 8) {
                    FridaySymbolImage(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField(friday: "搜索分支…", text: $search).textFieldStyle(.plain).accessibilityLabel(Text(friday: "搜索分支"))
                }.padding(14)
                ScrollView {
                    LazyVStack(spacing: 3) {
                        if includesCurrent && search.isEmpty { branchRow(nil, name: TaskRowPresentation.branch(options.git), detail: "当前检出") }
                        ForEach(branches) { branch in branchRow(branch.ref, name: branch.name, detail: branch.remote ? "远程分支" : "本地分支") }
                        if branches.isEmpty && (!includesCurrent || !search.isEmpty) { Text(friday: "没有匹配的分支").font(.callout).foregroundStyle(.secondary).padding(16) }
                    }.padding(8)
                }.frame(height: 220)
            } else {
                Text(friday: loading ? "读取分支…" : options?.git.status == "not_repository" ? "非 Git 工作区，将在当前目录执行。" : "无法读取分支，请刷新后重试。")
                    .font(.callout).foregroundStyle(.secondary).padding(16)
            }
        }.frame(width: 340)
    }

    private func branchRow(_ ref: String?, name: String, detail: String) -> some View {
        Button { select(ref) } label: {
            HStack(spacing: 10) {
                FridaySymbolImage(systemName: "arrow.triangle.branch").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 3) {
                    Text(name).lineLimit(1).truncationMode(.middle)
                    Text(fridayString: detail).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if selected == ref { FridaySymbolImage(systemName: "checkmark").foregroundStyle(FridayTheme.accent) }
            }.font(.callout).padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(selected == ref ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }.buttonStyle(FridaySymbolButtonStyle()).disabled(blocked || loading)
            .accessibilityAddTraits(selected == ref ? .isSelected : [])
    }
}

private struct TaskBranchRefreshButton: View {
    let action: () -> Void
    @State private var hovered = false
    @FocusState private var focused: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            FridaySymbolImage(systemName: "arrow.clockwise")
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(isEnabled && focused ? FridayTheme.accent : Color.secondary)
                .frame(width: 28, height: 28)
                .background(isEnabled && (hovered || focused) ? Color.primary.opacity(0.06) : .clear,
                    in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
                .opacity(isEnabled ? 1 : 0.45)
        }
        .buttonStyle(FridaySymbolButtonStyle())
        .focused($focused)
        // Popovers initially focus this button. Keep that focus usable without
        // the system highlight enclosing only the symbol's narrow bounds.
        .focusEffectDisabled()
        .onHover { hovered = $0 }
        .accessibilityLabel(Text(friday: "刷新分支"))
        .help(Text(friday: "刷新分支"))
    }
}
