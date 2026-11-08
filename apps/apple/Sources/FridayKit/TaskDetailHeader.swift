import SwiftUI

// A concrete view boundary keeps the toolbar's large generic body out of the
// transcript builder, which is re-evaluated when iOS switches retained tabs.
struct TaskDetailHeader: View {
    @Bindable var store: FridayStore
    let task: WorkItem
    var onOpenTask: ((String) -> Void)?
    @Binding var worktreeSetup: TaskWorktreeSetupSnapshot?
    @Binding var filesPanel: TaskFilesPanelState
    @Binding var activePanel: String
    @Binding var terminalShown: Bool
    @Binding var browserPanel: TaskBrowserPanelState
    @Binding var diffSelection: TaskDiffSelection?
    let workspacePanelVisible: Bool
    let toggleWorkspacePanel: () -> Void

    var body: some View {
        HStack(alignment: task.localAgent ? .center : .top, spacing: 14) {
            if task.localAgent {
                Text(store.projects.first { $0.id == task.projectId }?.name ?? task.agentName)
                    .font(.callout).foregroundStyle(.secondary).lineLimit(1)
                Text("/").foregroundStyle(.tertiary)
                #if os(macOS)
                if task.subagentOrigin != nil || task.delegationOrigin != nil { Text(task.title).font(.callout.weight(.medium)).lineLimit(1).textSelection(.enabled) }
                else { TaskHeaderTitle(store: store, task: task) }
                #else
                if task.subagentOrigin != nil || task.delegationOrigin != nil { Text(task.title).font(.callout.weight(.medium)).lineLimit(1) }
                else { HStack(spacing: 6) {
                    Text(task.title).font(.callout.weight(.medium)).lineLimit(1)
                        .opacity(task.titleRegeneration == nil ? 1 : 0.55)
                    FridaySymbolImage(systemName: "chevron.down").font(.system(size: 9)).foregroundStyle(.secondary)
                }.taskActions(store: store, task: task, opensMenu: true) }
                #endif
                Spacer(minLength: 8)
                #if os(iOS)
                if task.projectId != nil && task.subagentOrigin == nil { TaskProjectScriptsControl(store: store, task: task, updateSetup: { worktreeSetup = $0 }) }
                #endif
                TaskRelationshipsControl(store: store, task: task, canNavigate: onOpenTask != nil, openTask: { onOpenTask?($0) })
                TaskOpenInControl(store: store, task: task, enableShortcut: true)
                #if os(iOS)
                Button { if filesPanel.visible && activePanel == "files" { filesPanel.visible = false } else { filesPanel.visible = true; activePanel = "files" } } label: {
                    FridaySymbolImage(systemName: "folder").font(.system(size: 15)).frame(width: 24, height: 24)
                }.buttonStyle(FridaySymbolButtonStyle()).foregroundStyle(filesPanel.visible && activePanel == "files" ? FridayTheme.accent : .secondary)
                    .disabled(!store.connected).accessibilityLabel(Text(friday: "工作区文件"))
                #endif
                if task.git?.status == "repository" { TaskGitActionsControl(store: store, task: task) }
                #if os(iOS)
                Button { terminalShown.toggle() } label: {
                    FridaySymbolImage(systemName: "terminal").font(.system(size: 15)).frame(width: 24, height: 24)
                }.buttonStyle(FridaySymbolButtonStyle())
                    .foregroundStyle(terminalShown ? FridayTheme.accent : .secondary)
                    .disabled(task.projectId == nil)
                    .keyboardShortcut("j", modifiers: .command)
                    .accessibilityLabel(Text(friday: terminalShown ? "收起终端" : "显示终端"))
                    .help(Text(friday: "终端 · ⌘J"))
                Button {if browserPanel.visible && activePanel=="browser" {browserPanel.visible=false} else {browserPanel.visible=true;if browserPanel.tabs.isEmpty {browserPanel.open()};activePanel="browser"}} label: {
                    FridaySymbolImage(systemName:"globe").font(.system(size:15)).frame(width:24,height:24)
                }.buttonStyle(FridaySymbolButtonStyle()).foregroundStyle(browserPanel.visible && activePanel=="browser" ? FridayTheme.accent:.secondary).accessibilityLabel(Text(friday:"网页预览"))
                Button { if activePanel != "diff" { diffSelection = diffSelection ?? TaskDiffSelection(); activePanel = "diff" } else { diffSelection = diffSelection == nil ? TaskDiffSelection() : nil } } label: {
                    FridaySymbolImage(systemName: "sidebar.right").font(.system(size: 15)).frame(width: 24, height: 24)
                }.buttonStyle(FridaySymbolButtonStyle())
                    .foregroundStyle(diffSelection == nil ? .secondary : FridayTheme.accent)
                    .accessibilityLabel(Text(friday: diffSelection == nil ? "显示改动面板" : "关闭改动面板"))
                    .help(Text(friday: "文件改动与 Diff"))
                #else
                Button(action: toggleWorkspacePanel) {
                    FridaySymbolImage(systemName: "sidebar.right").font(.system(size: 15)).frame(width: 24, height: 24)
                }.buttonStyle(FridaySymbolButtonStyle())
                    .foregroundStyle(workspacePanelVisible ? FridayTheme.accent : .secondary)
                    .accessibilityLabel(Text(friday: workspacePanelVisible ? "收起侧栏" : "展开侧栏"))
                    .help(Text(friday: "文件、改动与终端"))
                #endif
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Friday").font(.caption).foregroundStyle(.secondary)
                    Text(task.title).font(.title3.weight(.semibold)).lineLimit(3).textSelection(.enabled)
                }
                Spacer(minLength: 8)
            }
        }
        #if os(iOS)
        .padding(.bottom, 8)
        #else
        .padding(.horizontal, 26).padding(.top, 24).padding(.bottom, 10)
        .background {
            if task.localAgent {
                Button("") {
                    if terminalShown && activePanel == "terminal" { toggleWorkspacePanel() }
                    else { terminalShown = true; activePanel = "terminal" }
                }.keyboardShortcut("j", modifiers: .command)
                    .disabled(task.projectId == nil).hidden().accessibilityHidden(true)
            }
            if task.localAgent && task.projectId != nil && task.subagentOrigin == nil {
                TaskProjectScriptsControl(store: store, task: task, showsControls: false, updateSetup: { worktreeSetup = $0 })
            }
        }
        #endif
    }
}
