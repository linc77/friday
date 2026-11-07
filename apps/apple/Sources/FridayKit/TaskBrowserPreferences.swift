import SwiftUI
import WebKit

@MainActor final class TaskBrowserPreferences:ObservableObject {
    static let changed=Notification.Name("FridayBrowserPreferencesChanged")
    private static var stores:[String:TaskBrowserPreferences]=[:]
    static func shared(server:String)->TaskBrowserPreferences {if let value=stores[server] {return value};let value=TaskBrowserPreferences(server:server);stores[server]=value;return value}
    let server:String
    private let persist:Bool
    @Published private(set) var profiles:[TaskBrowserProfile]
    @Published private(set) var defaults:TaskBrowserDefaults
    @Published private(set) var busy=false
    init(server:String,profiles:[TaskBrowserProfile]?=nil,defaults:TaskBrowserDefaults?=nil,persist:Bool=true) {
        self.server=server;self.persist=persist
        let resolved=TaskBrowserProfile.resolve(profiles ?? TaskDraftCache.load([TaskBrowserProfile].self,server:server,context:"browser-profiles") ?? []);self.profiles=resolved
        var value=defaults ?? TaskDraftCache.load(TaskBrowserDefaults.self,server:server,context:"browser-defaults") ?? TaskBrowserDefaults();value.validate(profiles:resolved);self.defaults=value
    }
    var userProfiles:[TaskBrowserProfile] {profiles.filter {!$0.builtIn}}
    @discardableResult func create(_ proposed:String="New profile")->TaskBrowserProfile? {
        guard !busy,userProfiles.count<24 else{return nil}
        let base=TaskBrowserProfile.limit(proposed.trimmingCharacters(in:.whitespacesAndNewlines),48);guard !base.isEmpty else{return nil}
        let taken=Set(profiles.map(\.name));var name=base,index=2
        while taken.contains(name) {let suffix=" \(index)";name=TaskBrowserProfile.limit(base,48-suffix.utf16.count)+suffix;index+=1}
        let profile=TaskBrowserProfile(id:"profile-"+UUID().uuidString,name:name,kind:"persistent");profiles.append(profile);save();return profile
    }
    func rename(_ id:String,to value:String) {
        let name=TaskBrowserProfile.limit(value.trimmingCharacters(in:.whitespacesAndNewlines),48)
        guard !busy,!name.isEmpty,let index=profiles.firstIndex(where:{$0.id==id && !$0.builtIn}) else{return};profiles[index].name=name;save()
    }
    func update(_ value:TaskBrowserDefaults) {guard !busy else{return};var value=value;value.validate(profiles:profiles);defaults=value;save()}
    func remove(_ id:String,clear:()async throws->Void)async throws {
        guard !busy,profiles.contains(where:{$0.id==id && !$0.builtIn}) else{return};busy=true;defer{busy=false}
        try await clear();profiles.removeAll {$0.id==id};defaults.validate(profiles:profiles);save()
    }
    func clear(_ id:String,action:()async throws->Void)async throws {
        guard !busy,profiles.contains(where:{$0.id==id}) else{return};busy=true;defer{busy=false};try await action()
    }
    #if os(macOS)
    struct ImportTarget {let profile:TaskBrowserProfile;let isNew:Bool;let token=UUID()}
    private var importOwner:UUID?
    func reserveImport(existing:String?,name:String)throws->ImportTarget {
        guard !busy else{throw TaskBrowserImportFailure.sessionUnavailable}
        let target:ImportTarget
        if let existing {guard let profile=profiles.first(where:{$0.id==existing && $0.id != "incognito"}) else{throw TaskBrowserImportFailure.sessionUnavailable};target = .init(profile:profile,isNew:false)}
        else {
            guard userProfiles.count<24 else{throw TaskBrowserImportFailure.profileLimitReached}
            let base=TaskBrowserProfile.limit(TaskBrowserAnnotationText.trim(name),48);let taken=Set(profiles.map(\.name));var value=base.isEmpty ? "Imported profile":base,index=2
            while taken.contains(value) {let suffix=" \(index)";value=TaskBrowserProfile.limit(base,48-suffix.utf16.count)+suffix;index+=1}
            target = .init(profile:.init(id:"profile-"+UUID().uuidString,name:value,kind:"persistent"),isNew:true)
        }
        busy=true;importOwner=target.token;return target
    }
    func finishImport(_ target:ImportTarget,imported:Int)throws {
        guard importOwner==target.token else{throw TaskBrowserImportFailure.sessionUnavailable};defer{cancelImport(target)};guard target.isNew,imported>0 else{return}
        guard userProfiles.count<24 else{throw TaskBrowserImportFailure.profileLimitReached}
        profiles.append(target.profile);save()
        if persist,TaskDraftCache.load([TaskBrowserProfile].self,server:server,context:"browser-profiles")?.contains(target.profile) != true {profiles.removeAll {$0.id==target.profile.id};throw TaskBrowserImportFailure.profileNotSaved}
    }
    func cancelImport(_ target:ImportTarget) {guard importOwner==target.token else{return};importOwner=nil;busy=false}
    #endif
    private func save() {if persist {TaskDraftCache.save(userProfiles,server:server,context:"browser-profiles");TaskDraftCache.save(defaults,server:server,context:"browser-defaults")};NotificationCenter.default.post(name:Self.changed,object:server)}
}
enum TaskBrowserWebsiteData {
    static let cookies:Set<String>=[WKWebsiteDataTypeCookies,WKWebsiteDataTypeLocalStorage,WKWebsiteDataTypeIndexedDBDatabases,WKWebsiteDataTypeServiceWorkerRegistrations]
    static let cache:Set<String>=[WKWebsiteDataTypeDiskCache,WKWebsiteDataTypeMemoryCache]
    @MainActor static func clear(_ store:WKWebsiteDataStore,types:Set<String>)async {await withCheckedContinuation {continuation in store.removeData(ofTypes:types,modifiedSince:.distantPast){continuation.resume()}}}
}
