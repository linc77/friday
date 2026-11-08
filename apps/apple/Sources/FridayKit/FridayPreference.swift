import Foundation
import Observation
import SwiftUI

/// Persisted preferences are observed by key and effective value. A draft or
/// panel-width write must not invalidate appearance, language or every sidebar.
@MainActor @propertyWrapper struct FridayPreference<Value: Equatable>: DynamicProperty {
    @State private var entry: FridayPreferenceEntry<Value>

    private init(_ key: String, defaultValue: Value, store: FridayPreferenceStore,
                 read: @escaping (UserDefaults, String) -> Value?,
                 write: @escaping (UserDefaults, String, Value) -> Void) {
        _entry = State(initialValue: store.entry(key, defaultValue: defaultValue, read: read, write: write))
    }

    var wrappedValue: Value {
        get { entry.value }
        nonmutating set { entry.set(newValue) }
    }
    var projectedValue: Binding<Value> { Binding(get: { entry.value }, set: { entry.set($0) }) }
}

extension FridayPreference where Value == Bool {
    init(wrappedValue: Bool, _ key: String, store: FridayPreferenceStore? = nil) {
        self.init(key, defaultValue: wrappedValue, store: store ?? .standard,
                  read: { $0.object(forKey: $1) == nil ? nil : $0.bool(forKey: $1) },
                  write: { $0.set($2, forKey: $1) })
    }
}
extension FridayPreference where Value == Int {
    init(wrappedValue: Int, _ key: String, store: FridayPreferenceStore? = nil) {
        self.init(key, defaultValue: wrappedValue, store: store ?? .standard,
                  read: { $0.object(forKey: $1) == nil ? nil : $0.integer(forKey: $1) },
                  write: { $0.set($2, forKey: $1) })
    }
}
extension FridayPreference where Value == Double {
    init(wrappedValue: Double, _ key: String, store: FridayPreferenceStore? = nil) {
        self.init(key, defaultValue: wrappedValue, store: store ?? .standard,
                  read: { $0.object(forKey: $1) == nil ? nil : $0.double(forKey: $1) },
                  write: { $0.set($2, forKey: $1) })
    }
}
extension FridayPreference where Value == String {
    init(wrappedValue: String, _ key: String, store: FridayPreferenceStore? = nil) {
        self.init(key, defaultValue: wrappedValue, store: store ?? .standard,
                  read: { $0.string(forKey: $1) }, write: { $0.set($2, forKey: $1) })
    }
}
extension FridayPreference where Value == Data {
    init(wrappedValue: Data, _ key: String, store: FridayPreferenceStore? = nil) {
        self.init(key, defaultValue: wrappedValue, store: store ?? .standard,
                  read: { $0.data(forKey: $1) }, write: { $0.set($2, forKey: $1) })
    }
}
extension FridayPreference where Value: RawRepresentable, Value.RawValue == String {
    init(wrappedValue: Value, _ key: String, store: FridayPreferenceStore? = nil) {
        self.init(key, defaultValue: wrappedValue, store: store ?? .standard,
                  read: { $0.string(forKey: $1).flatMap(Value.init(rawValue:)) },
                  write: { $0.set($2.rawValue, forKey: $1) })
    }
}

@MainActor private protocol FridayPreferenceRefreshing: AnyObject { func refresh() }
private final class WeakFridayPreference {
    weak var entry: (any FridayPreferenceRefreshing)?
    init(_ entry: any FridayPreferenceRefreshing) { self.entry = entry }
}

private final class FridayPreferenceObserver: @unchecked Sendable {
    let token: NSObjectProtocol
    init(_ token: NSObjectProtocol) { self.token = token }
    deinit { NotificationCenter.default.removeObserver(token) }
}

@MainActor final class FridayPreferenceStore {
    static let standard = FridayPreferenceStore(defaults: .standard)
    private let defaults: UserDefaults
    private var entries: [String: [WeakFridayPreference]] = [:]
    private var observer: FridayPreferenceObserver?

    init(defaults: UserDefaults) {
        self.defaults = defaults
        observer = FridayPreferenceObserver(NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification,
            object: defaults, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            })
    }

    /// Direct UserDefaults writes (drafts, migrations and other windows) remain
    /// supported. One store observer reconciles live keys without publishing a
    /// store-wide change, and dead view subscriptions are weakly held.
    func refresh() {
        for key in Array(entries.keys) { refresh(key) }
    }
    private func refresh(_ key: String) {
        let live = entries[key, default: []].filter { $0.entry != nil }
        if live.isEmpty { entries.removeValue(forKey: key) }
        else {
            entries[key] = live
            for item in live { item.entry?.refresh() }
        }
    }
    func entry<Value: Equatable>(_ key: String, defaultValue: Value,
        read: @escaping (UserDefaults, String) -> Value?,
        write: @escaping (UserDefaults, String, Value) -> Void) -> FridayPreferenceEntry<Value> {
        let live = entries[key, default: []].filter { $0.entry != nil }
        for item in live {
            if let entry = item.entry as? FridayPreferenceEntry<Value>, entry.defaultValue == defaultValue { return entry }
        }
        let entry = FridayPreferenceEntry(defaultValue: defaultValue, read: { [defaults] in read(defaults, key) },
            write: { [self, defaults] value in
                // Avoid emitting a defaults notification for a no-op write.
                if read(defaults, key) != value { write(defaults, key, value) }
                self.refresh(key)
            })
        entries[key] = live + [WeakFridayPreference(entry)]
        return entry
    }
}

@MainActor @Observable final class FridayPreferenceEntry<Value: Equatable>: FridayPreferenceRefreshing {
    private(set) var value: Value
    let defaultValue: Value
    @ObservationIgnored private let read: () -> Value?
    @ObservationIgnored private let write: (Value) -> Void
    init(defaultValue: Value, read: @escaping () -> Value?, write: @escaping (Value) -> Void) {
        self.defaultValue = defaultValue; self.read = read; self.write = write
        value = read() ?? defaultValue
    }
    func refresh() {
        let next = read() ?? defaultValue
        if next != value { value = next }
    }
    func set(_ value: Value) { write(value); refresh() }
}
