import XCTest
import Observation
import SwiftUI
@testable import FridayKit
#if os(macOS)
import AppKit

final class FridayPreferenceTests: XCTestCase {
    private final class Changes: @unchecked Sendable { var count = 0 }

    @MainActor private func string(_ key: String, fallback: String = "default", in store: FridayPreferenceStore) -> FridayPreferenceEntry<String> {
        store.entry(key, defaultValue: fallback, read: { $0.string(forKey: $1) }, write: { $0.set($2, forKey: $1) })
    }

    @MainActor func testUnrelatedAndEqualWritesDoNotInvalidateSubscribers() throws {
        let suite = "FridayPreferenceTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = FridayPreferenceStore(defaults: defaults)
        let language = string("language", in: store), appearance = string("appearance", in: store)
        let languageChanges = Changes(), appearanceChanges = Changes()
        withObservationTracking { _ = language.value } onChange: { languageChanges.count += 1 }
        withObservationTracking { _ = appearance.value } onChange: { appearanceChanges.count += 1 }
        for width in 400..<520 {
            defaults.set(width, forKey: "panelWidth")
            defaults.set("draft-\(width)", forKey: "draft")
            store.refresh()
        }
        XCTAssertEqual(languageChanges.count, 0)
        XCTAssertEqual(appearanceChanges.count, 0)
        appearance.set("dark")
        XCTAssertEqual(appearance.value, "dark")
        XCTAssertEqual(appearanceChanges.count, 1)
        XCTAssertEqual(languageChanges.count, 0)
        let repeated = Changes()
        withObservationTracking { _ = appearance.value } onChange: { repeated.count += 1 }
        for _ in 0..<120 { appearance.set("dark"); store.refresh() }
        XCTAssertEqual(repeated.count, 0)
    }

    @MainActor func testDirectDefaultsWritesAndRemovalReachExistingBindings() throws {
        let suite = "FridayPreferenceTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = FridayPreferenceStore(defaults: defaults)
        let first = string("language", fallback: "zh", in: store)
        let second = string("language", fallback: "zh", in: store)
        defaults.set("en", forKey: "language")
        NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: defaults)
        XCTAssertEqual(first.value, "en")
        XCTAssertEqual(second.value, "en")
        second.set("ja")
        XCTAssertEqual(first.value, "ja")
        XCTAssertEqual(defaults.string(forKey: "language"), "ja")
        defaults.removeObject(forKey: "language")
        NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: defaults)
        XCTAssertEqual(first.value, "zh")
    }

    @MainActor func testDefaultsDomainsAndFallbacksStayIndependent() throws {
        let a = "FridayPreferenceTests.\(UUID())", b = "FridayPreferenceTests.\(UUID())"
        let da = try XCTUnwrap(UserDefaults(suiteName: a)), db = try XCTUnwrap(UserDefaults(suiteName: b))
        defer { da.removePersistentDomain(forName: a); db.removePersistentDomain(forName: b) }
        let sa = FridayPreferenceStore(defaults: da), sb = FridayPreferenceStore(defaults: db)
        let first = string("key", fallback: "one", in: sa)
        let fallback = string("key", fallback: "two", in: sa)
        let other = string("key", fallback: "other", in: sb)
        XCTAssertEqual(first.value, "one"); XCTAssertEqual(fallback.value, "two")
        first.set("saved")
        XCTAssertEqual(fallback.value, "saved"); XCTAssertEqual(other.value, "other")
        da.removeObject(forKey: "key"); sa.refresh()
        XCTAssertEqual(first.value, "one"); XCTAssertEqual(fallback.value, "two")
    }

    @MainActor func testPreferenceSubscriptionsDoNotRetainDiscardedViews() throws {
        let suite = "FridayPreferenceTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = FridayPreferenceStore(defaults: defaults)
        weak var released: FridayPreferenceEntry<String>?
        do { let entry = string("key", in: store); released = entry; XCTAssertNotNil(released) }
        XCTAssertNil(released)
        defaults.set("current", forKey: "key"); store.refresh()
        XCTAssertEqual(string("key", in: store).value, "current")
    }

    @MainActor func testLivePreferenceOwnsItsStoreWithoutALifetimeCycle() throws {
        let suite = "FridayPreferenceTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        weak var retainedStore: FridayPreferenceStore?
        var entry: FridayPreferenceEntry<String>?
        do {
            let store = FridayPreferenceStore(defaults: defaults)
            retainedStore = store
            entry = string("key", in: store)
        }
        XCTAssertNotNil(retainedStore)
        defaults.set("external", forKey: "key")
        NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: defaults)
        XCTAssertEqual(entry?.value, "external")
        entry = nil
        XCTAssertNil(retainedStore)
    }

    @MainActor func testExistingStorageFormatsAndInvalidEnumFallback() throws {
        let suite = "FridayPreferenceTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = FridayPreferenceStore(defaults: defaults)
        let flag = FridayPreference(wrappedValue: false, "flag", store: store)
        let count = FridayPreference(wrappedValue: 3, "count", store: store)
        let width = FridayPreference(wrappedValue: 400.0, "width", store: store)
        let data = FridayPreference(wrappedValue: Data(), "data", store: store)
        enum Mode: String { case light, dark }
        let mode = FridayPreference(wrappedValue: Mode.light, "mode", store: store)
        flag.wrappedValue = true; count.wrappedValue = 7; width.wrappedValue = 480.5
        data.wrappedValue = Data([1, 2]); mode.wrappedValue = .dark
        XCTAssertEqual(defaults.bool(forKey: "flag"), true)
        XCTAssertEqual(defaults.integer(forKey: "count"), 7)
        XCTAssertEqual(defaults.double(forKey: "width"), 480.5)
        XCTAssertEqual(defaults.data(forKey: "data"), Data([1, 2]))
        XCTAssertEqual(defaults.string(forKey: "mode"), "dark")
        defaults.set("removed-mode", forKey: "mode"); store.refresh()
        XCTAssertEqual(mode.wrappedValue, .light)
    }

    @MainActor func testMountedViewIgnoresOtherKeysAndUpdatesForItsOwnKey() async throws {
        let suite = "FridayPreferenceTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = FridayPreferenceStore(defaults: defaults), changes = Changes()
        let root = NSHostingView(rootView: PreferenceProbe(store: store) { changes.count += 1 })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = root
        defer { window.contentView = nil }
        for _ in 0..<6 { root.layoutSubtreeIfNeeded(); await Task.yield() }
        let initial = changes.count
        XCTAssertGreaterThan(initial, 0)
        for width in 400..<520 { defaults.set(width, forKey: "panelWidth"); store.refresh() }
        for _ in 0..<6 { root.layoutSubtreeIfNeeded(); await Task.yield() }
        XCTAssertEqual(changes.count, initial, "Saving panel width must not rebuild a language consumer")
        defaults.set("en", forKey: "language"); store.refresh()
        for _ in 0..<6 { root.layoutSubtreeIfNeeded(); await Task.yield() }
        XCTAssertGreaterThan(changes.count, initial)
    }
}

@MainActor private struct PreferenceProbe: View {
    @FridayPreference("language") private var language = "zh"
    let rendered: () -> Void
    init(store: FridayPreferenceStore, rendered: @escaping () -> Void) {
        _language = FridayPreference(wrappedValue: "zh", "language", store: store)
        self.rendered = rendered
    }
    var body: some View { let _ = rendered(); Text(language) }
}
#endif
