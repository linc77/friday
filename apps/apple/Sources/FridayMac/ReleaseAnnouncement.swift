import AppKit
import SwiftUI
import FridayKit

@MainActor
final class ReleaseAnnouncement: NSObject, NSWindowDelegate {
    static let shared = ReleaseAnnouncement()
    private var window: NSWindow?
    private var history: ReleaseNotesHistory?

    private override init() {
        super.init()
        if let url = Bundle.main.url(forResource: "ReleaseNotes", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let releases = try? JSONDecoder().decode([ReleaseNotes].self, from: data),
           let buildString = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
           let build = Int(buildString),
           let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String {
            history = ReleaseNotesHistory(releases: releases, currentBuild: build, currentVersion: version)
        }
    }

    var available: Bool { history != nil }

    func show(onlyUnread: Bool = false) {
        guard let history, !onlyUnread || !history.unread.isEmpty else { return }
        if let window {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let content = ReleaseAnnouncementView(history: history, showsHistory: !onlyUnread) { [weak self] in self?.close() }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 580),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "\(FridayAppName.displayName) · 更新公告"
        window.minSize = NSSize(width: 620, height: 440)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = NSHostingView(rootView: content)
        self.window = window
        if let parent = NSApp.mainWindow, parent.attachedSheet == nil {
            parent.beginSheet(window)
        } else {
            window.center()
            window.makeKeyAndOrderFront(nil)
        }
    }

    private func close() {
        guard let window else { return }
        if let parent = window.sheetParent { parent.endSheet(window) }
        window.close()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if let parent = sender.sheetParent { parent.endSheet(sender) }
        return true
    }

    func windowWillClose(_ notification: Notification) {
        history?.acknowledge()
        window = nil
    }
}

private struct ReleaseAnnouncementView: View {
    let history: ReleaseNotesHistory
    @State var showsHistory: Bool
    let dismiss: () -> Void
    @AppStorage("friday.appearance") private var appearance = "system"

    private var releases: [ReleaseNotes] { showsHistory ? history.releases : history.unread }
    private var subtitle: String {
        if showsHistory { return "全部版本的更新内容" }
        if let receipt = history.receipt { return "自 v\(receipt.version) 以来的更新内容" }
        return "看看这个版本带来了什么变化"
    }
    private var range: String {
        guard let oldest = releases.last, let newest = releases.first else { return "" }
        return releases.count == 1 ? "本次更新 · v\(newest.version)" : "\(releases.count) 个版本 · v\(oldest.version) – v\(newest.version)"
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("更新到 v\(history.current.version)")
                    .font(.system(size: 23, weight: .semibold))
                    .accessibilityAddTraits(.isHeader)
                Text(subtitle).font(.system(size: 13)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 30).padding(.vertical, 25)

            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    Text(range).font(.system(size: 13)).foregroundStyle(.secondary)
                    ForEach(ReleaseNoteCategory.allCases, id: \.self) { category in
                        let entries = releases.flatMap { release in
                            release.sections.filter { $0.category == category }.flatMap { section in
                                section.items.enumerated().map { index, text in
                                    AnnouncementEntry(id: "\(release.build)-\(category.rawValue)-\(index)", version: release.version, text: text)
                                }
                            }
                        }
                        if !entries.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack(alignment: .firstTextBaseline, spacing: 9) {
                                    Text(category.title).font(.system(size: 16, weight: .semibold))
                                        .accessibilityAddTraits(.isHeader)
                                    Text("\(entries.count)").font(.system(size: 13)).foregroundStyle(.tertiary)
                                }
                                ForEach(entries) { entry in
                                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                                        Text("•").foregroundStyle(.secondary).accessibilityHidden(true)
                                        (Text(entry.text).foregroundColor(.primary.opacity(0.8))
                                         + Text("  v\(entry.version)").foregroundColor(.secondary))
                                            .fixedSize(horizontal: false, vertical: true)
                                            .textSelection(.enabled)
                                    }
                                    .font(.system(size: 14)).lineSpacing(5)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 30).padding(.vertical, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .id(showsHistory)
            Divider()
            HStack {
                if !showsHistory && history.releases.count > releases.count {
                    Button("查看历史更新") { showsHistory = true }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .fridayInteractiveCursor()
                }
                Spacer()
                Button("开始使用", action: dismiss)
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .keyboardShortcut(.defaultAction)
                    .fridayInteractiveCursor()
            }
            .padding(.horizontal, 26).padding(.vertical, 18)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .tint(.primary)
        .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
        .onExitCommand(perform: dismiss)
    }
}

private struct AnnouncementEntry: Identifiable {
    let id: String
    let version: String
    let text: String
}
