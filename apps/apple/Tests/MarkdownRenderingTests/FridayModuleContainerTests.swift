import XCTest
#if os(macOS)
import AppKit
import SwiftUI
@testable import FridayKit

final class FridayModuleContainerTests: XCTestCase {
    @MainActor func testSwitchKeepsDraftAndPausesHiddenRenderingAndTasks() async throws {
        let probe = ModuleProbeState()
        let viewport = FridayModuleViewport(frame: NSRect(x: 0, y: 0, width: 500, height: 400))
        let window = window(containing: viewport)
        defer { viewport.reset(); window.contentView = nil }
        func show(_ section: FridaySection) {
            viewport.update(selection: section, scope: "host-a", content: AnyView(ModuleProbe(section: section, probe: probe)))
        }

        show(.tasks); await settle(viewport)
        let taskIdentity = try XCTUnwrap(probe.identities[.tasks])
        probe.editDraft[.tasks]?("unsent draft")
        await settle(viewport)
        XCTAssertEqual(probe.drafts[.tasks], "unsent draft")
        XCTAssertEqual(probe.running, [.tasks])

        show(.inbox); await settle(viewport)
        XCTAssertEqual(viewport.subviews.count, 1)
        XCTAssertEqual(probe.running, [.inbox], "Hidden view tasks must cancel without stopping the shared service")
        let hiddenRenders = probe.renders[.tasks]
        probe.revision += 1
        await settle(viewport)
        XCTAssertEqual(probe.renders[.tasks], hiddenRenders, "Hidden modules must not render on store publications")

        show(.tasks); await settle(viewport)
        XCTAssertEqual(probe.identities[.tasks], taskIdentity)
        XCTAssertEqual(probe.drafts[.tasks], "unsent draft")
        XCTAssertEqual(probe.revisions[.tasks], 1, "Returning must show the latest data")
        XCTAssertEqual(probe.running, [.tasks])
        XCTAssertEqual(viewport.subviews.count, 1)
    }

    @MainActor func testHostChangeDropsRetainedStateAndResetCancelsTasks() async throws {
        let probe = ModuleProbeState()
        let viewport = FridayModuleViewport(frame: NSRect(x: 0, y: 0, width: 500, height: 400))
        let window = window(containing: viewport)
        defer { viewport.reset(); window.contentView = nil }
        func show(_ scope: String) {
            viewport.update(selection: .tasks, scope: scope, content: AnyView(ModuleProbe(section: .tasks, probe: probe)))
        }
        show("host-a"); await settle(viewport)
        let previous = probe.identities[.tasks]
        probe.editDraft[.tasks]?("host-a draft"); await settle(viewport)
        show("host-b"); await settle(viewport)
        XCTAssertNotEqual(probe.identities[.tasks], previous)
        XCTAssertEqual(probe.drafts[.tasks], "")
        viewport.reset(); await settle(viewport)
        XCTAssertTrue(probe.running.isEmpty)
        XCTAssertTrue(viewport.subviews.isEmpty)
    }

    @MainActor func testRetainedModuleReceivesCurrentLocaleAndBindings() async throws {
        let probe = ModuleProbeState()
        let fixture = ModuleContainerFixture(probe: probe)
        let root = NSHostingView(rootView: ModuleContainerFixtureView(fixture: fixture))
        root.frame = NSRect(x: 0, y: 0, width: 500, height: 400)
        let window = window(containing: root)
        defer { window.contentView = nil }
        await settle(root)
        let previous = probe.identities[.tasks]
        fixture.selection = .inbox; await settle(root)
        fixture.locale = "en"; await settle(root)
        fixture.selection = .tasks; await settle(root)
        XCTAssertEqual(probe.identities[.tasks], previous)
        XCTAssertEqual(probe.locales[.tasks], "en")
        probe.editSelection?(.settings); await settle(root)
        XCTAssertEqual(fixture.selection, .settings, "Bindings must still reach the original window state")
        XCTAssertEqual(probe.running, [.settings])
    }

    @MainActor func testTaskWorkingSetEvictsOldestAndDropsDeletedPages() async throws {
        let probe = ModuleProbeState()
        let viewport = FridayModuleViewport(frame: NSRect(x: 0, y: 0, width: 500, height: 400))
        let window = window(containing: viewport)
        defer { viewport.reset(); window.contentView = nil }
        func show(_ section: FridaySection, valid: Set<FridaySection>? = nil) async {
            viewport.update(selection: section, scope: "host", content: AnyView(ModuleProbe(section: section, probe: probe)),
                            capacity: 2, validKeys: valid)
            await settle(viewport)
        }
        await show(.tasks)
        let taskIdentity = probe.identities[.tasks]
        probe.editDraft[.tasks]?("keep this draft"); await settle(viewport)
        await show(.inbox)
        let evictedIdentity = probe.identities[.inbox]
        await show(.tasks)
        await show(.settings)
        let deletedIdentity = probe.identities[.settings]
        await show(.tasks, valid: [.tasks, .inbox])
        XCTAssertEqual(probe.identities[.tasks], taskIdentity)
        XCTAssertEqual(probe.drafts[.tasks], "keep this draft")
        XCTAssertEqual(probe.running, [.tasks])
        await show(.inbox)
        XCTAssertNotEqual(probe.identities[.inbox], evictedIdentity, "Least recently visited pages must release their graph")
        await show(.settings)
        XCTAssertNotEqual(probe.identities[.settings], deletedIdentity, "Deleted/recreated tasks must not reuse old state")
        XCTAssertEqual(viewport.subviews.count, 1)
    }

    @MainActor func testNewTaskPlaceholderAndTaskIDsHaveDistinctRetainedState() async throws {
        let probe = ModuleProbeState()
        let viewport = FridayRetainedViewport<String?>(frame: NSRect(x: 0, y: 0, width: 500, height: 400))
        let window = window(containing: viewport)
        defer { viewport.reset(); window.contentView = nil }
        func show(_ id: String?, section: FridaySection) async {
            viewport.update(selection: id, scope: "host", content: AnyView(ModuleProbe(section: section, probe: probe)),
                            capacity: 4, validKeys: [nil, "task-a"])
            await settle(viewport)
        }
        await show(nil, section: .inbox)
        let newTaskIdentity = probe.identities[.inbox]
        probe.editDraft[.inbox]?("new task draft"); await settle(viewport)
        await show("task-a", section: .tasks)
        let taskIdentity = probe.identities[.tasks]
        await show(nil, section: .inbox)
        XCTAssertEqual(probe.identities[.inbox], newTaskIdentity)
        XCTAssertEqual(probe.drafts[.inbox], "new task draft")
        await show("task-a", section: .tasks)
        XCTAssertEqual(probe.identities[.tasks], taskIdentity)
        XCTAssertEqual(probe.running, [.tasks])
    }

    @MainActor private func window(containing view: NSView) -> NSWindow {
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        return window
    }

    @MainActor private func settle(_ view: NSView) async {
        view.layoutSubtreeIfNeeded()
        try? await Task.sleep(for: .milliseconds(30))
        view.layoutSubtreeIfNeeded()
        await Task.yield()
    }
}

@MainActor private final class ModuleProbeState: ObservableObject {
    @Published var revision = 0
    var identities: [FridaySection: UUID] = [:]
    var renders: [FridaySection: Int] = [:]
    var revisions: [FridaySection: Int] = [:]
    var drafts: [FridaySection: String] = [:]
    var locales: [FridaySection: String] = [:]
    var running: Set<FridaySection> = []
    var editDraft: [FridaySection: (String) -> Void] = [:]
    var editSelection: ((FridaySection) -> Void)?
}

private struct ModuleProbe: View {
    let section: FridaySection
    @ObservedObject var probe: ModuleProbeState
    var selection: Binding<FridaySection> = .constant(.tasks)
    @State private var identity = UUID()
    @State private var draft = ""
    @Environment(\.locale) private var locale

    var body: some View {
        probe.identities[section] = identity
        probe.renders[section, default: 0] += 1
        probe.revisions[section] = probe.revision
        probe.drafts[section] = draft
        probe.locales[section] = locale.identifier
        probe.editDraft[section] = { draft = $0 }
        probe.editSelection = { selection.wrappedValue = $0 }
        return TextField("Draft", text: $draft).task {
            probe.running.insert(section)
            defer { probe.running.remove(section) }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
    }
}

@MainActor private final class ModuleContainerFixture: ObservableObject {
    @Published var selection: FridaySection = .tasks
    @Published var locale = "zh-Hans"
    let probe: ModuleProbeState
    init(probe: ModuleProbeState) { self.probe = probe }
}

private struct ModuleContainerFixtureView: View {
    @ObservedObject var fixture: ModuleContainerFixture
    var body: some View {
        FridayModuleContainer(selection: fixture.selection, scope: "host") {
            ModuleProbe(section: fixture.selection, probe: fixture.probe, selection: $fixture.selection)
        }.environment(\.locale, Locale(identifier: fixture.locale))
    }
}
#endif
