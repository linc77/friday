#if os(macOS)
import Foundation
import AppKit
import Security
import Darwin

struct TaskBrowserImportProfile:Identifiable,Equatable,Sendable {
    let directory:String;let name:String;var cookieCount:Int?=nil
    var id:String {directory}
}
struct TaskBrowserImportSource:Identifiable,Sendable {
    let definition:TaskBrowserImportDefinition
    let profiles:[TaskBrowserImportProfile]
    let unavailable:TaskBrowserImportFailure?
    var id:String {definition.id}
}
struct TaskBrowserImportDefinition:Sendable {
    let id:String;let name:String;let engine:String;let segments:[String];let bundle:String
    var service:String?=nil;var account:String?=nil
    static let all:[Self]=[
        .init(id:"chrome",name:"Chrome",engine:"chromium",segments:["Google","Chrome"],bundle:"com.google.Chrome",service:"Chrome Safe Storage",account:"Chrome"),
        .init(id:"edge",name:"Microsoft Edge",engine:"chromium",segments:["Microsoft Edge"],bundle:"com.microsoft.edgemac",service:"Microsoft Edge Safe Storage",account:"Microsoft Edge"),
        .init(id:"brave",name:"Brave",engine:"chromium",segments:["BraveSoftware","Brave-Browser"],bundle:"com.brave.Browser",service:"Brave Safe Storage",account:"Brave"),
        .init(id:"vivaldi",name:"Vivaldi",engine:"chromium",segments:["Vivaldi"],bundle:"com.vivaldi.Vivaldi",service:"Vivaldi Safe Storage",account:"Vivaldi"),
        .init(id:"opera",name:"Opera",engine:"chromium",segments:["com.operasoftware.Opera"],bundle:"com.operasoftware.Opera",service:"Opera Safe Storage",account:"Opera"),
        .init(id:"arc",name:"Arc",engine:"chromium",segments:["Arc","User Data"],bundle:"company.thebrowser.Browser",service:"Arc Safe Storage",account:"Arc"),
        .init(id:"helium",name:"Helium",engine:"chromium",segments:["net.imput.helium"],bundle:"net.imput.helium",service:"Helium Storage Key",account:"Helium"),
        .init(id:"firefox",name:"Firefox",engine:"firefox",segments:["Firefox"],bundle:"org.mozilla.firefox"),
        .init(id:"safari",name:"Safari",engine:"safari",segments:[],bundle:"com.apple.Safari")
    ]
    func root(home:URL)->URL {
        if engine=="safari" {return home.appendingPathComponent("Library/Containers/com.apple.Safari/Data/Library/Cookies",isDirectory:true)}
        return segments.reduce(home.appendingPathComponent("Library/Application Support",isDirectory:true)) {$0.appendingPathComponent($1,isDirectory:true)}
    }
}
enum TaskBrowserImportProcesses {
    static func alive(_ pid:Int32)->Bool {kill(pid,0)==0 || errno != ESRCH}
    static func chromiumLock(_ target:String,host:String,alive:(Int32)->Bool=Self.alive)->Bool {
        guard let separator=target.lastIndex(of:"-"),separator != target.startIndex else{return true}
        let owner=String(target[..<separator]),text=String(target[target.index(after:separator)...])
        guard text.range(of:#"^\d+$"#,options:.regularExpression) != nil,let pid=Int32(text),pid>0,owner==host else{return true};return alive(pid)
    }
    static func firefoxLock(_ target:String,addresses:Set<String>,alive:(Int32)->Bool=Self.alive)->Bool {
        guard let separator=target.lastIndex(of:":"),addresses.contains(String(target[..<separator])) else{return true}
        var text=String(target[target.index(after:separator)...]);if text.hasPrefix("+") {text.removeFirst()}
        guard text.range(of:#"^\d+$"#,options:.regularExpression) != nil,let pid=Int32(text),pid>0 else{return true};return alive(pid)
    }
    static func posixLock(_ path:String)->Bool {
        let fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);guard fd>=0 else{return false};defer{Darwin.close(fd)}
        var record=flock(l_start:0,l_len:0,l_pid:0,l_type:Int16(F_WRLCK),l_whence:Int16(SEEK_SET))
        guard fcntl(fd,F_GETLK,&record)==0 else{return false};return record.l_type != Int16(F_UNLCK)
    }
    private static func addresses()->Set<String> {
        var result:Set<String>=["127.0.0.1","::1"],head:UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head)==0 else{return result};defer{freeifaddrs(head)};var node=head
        while let current=node {defer{node=current.pointee.ifa_next};guard let address=current.pointee.ifa_addr,[AF_INET,AF_INET6].contains(Int32(address.pointee.sa_family)) else{continue};var text=[CChar](repeating:0,count:Int(NI_MAXHOST));if getnameinfo(address,socklen_t(address.pointee.sa_len),&text,socklen_t(text.count),nil,0,NI_NUMERICHOST)==0 {result.insert(String(cString:text))}};return result
    }
    static func running(_ source:TaskBrowserImportDefinition,root:URL,profiles:[TaskBrowserImportProfile])->Bool {
        if source.engine=="safari" {return false} // Safari replaces its binary jar atomically, as in T3.
        if source.engine=="chromium" {
            do {let target=try FileManager.default.destinationOfSymbolicLink(atPath:root.appendingPathComponent("SingletonLock").path);var host=[CChar](repeating:0,count:256);gethostname(&host,host.count);return chromiumLock(target,host:String(cString:host))}
            catch {let error=error as NSError;return ![NSFileNoSuchFileError,NSFileReadNoSuchFileError].contains(error.code) && (error.userInfo[NSUnderlyingErrorKey] as? NSError)?.code != Int(ENOENT)}
        }
        let local=addresses()
        return profiles.contains {profile in
            let directory=profile.directory.hasPrefix("/") ? URL(fileURLWithPath:profile.directory):root.appendingPathComponent(profile.directory)
            if let target=try? FileManager.default.destinationOfSymbolicLink(atPath:directory.appendingPathComponent("lock").path),firefoxLock(target,addresses:local) {return true}
            return posixLock(directory.appendingPathComponent(".parentlock").path)
        }
    }

}
actor TaskBrowserCookieImporter {
    let home:URL
    private let temporary:URL
    private let running:(@Sendable (TaskBrowserImportDefinition,URL)async->Bool)?
    private let key:@Sendable (TaskBrowserImportDefinition)throws->Data
    init(home:URL=FileManager.default.homeDirectoryForCurrentUser,temporary:URL=FileManager.default.temporaryDirectory,running:(@Sendable (TaskBrowserImportDefinition,URL)async->Bool)?=nil,key:@escaping @Sendable (TaskBrowserImportDefinition)throws->Data={source in try TaskBrowserCookieImporter.keychain(source)}) {self.home=home;self.temporary=temporary;self.running=running;self.key=key}
    static func keychain(_ source:TaskBrowserImportDefinition)throws->Data {
        guard let service=source.service,let account=source.account else{throw TaskBrowserImportFailure.keychainUnavailable}
        let request:[CFString:Any]=[kSecClass:kSecClassGenericPassword,kSecAttrService:service,kSecAttrAccount:account,kSecReturnData:true,kSecMatchLimit:kSecMatchLimitOne]
        var result:CFTypeRef?;let status=SecItemCopyMatching(request as CFDictionary,&result)
        if status==errSecItemNotFound {throw TaskBrowserImportFailure.keychainItemMissing}
        if [errSecUserCanceled,errSecAuthFailed,errSecInteractionNotAllowed].contains(status) {throw TaskBrowserImportFailure.needsKeychainApproval}
        guard status==errSecSuccess,let data=result as? Data else{throw TaskBrowserImportFailure.keychainUnavailable}
        guard !data.isEmpty else{throw TaskBrowserImportFailure.keychainItemMissing};return data
    }
    private func regular(_ url:URL)->Bool {guard let values=try? url.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey]) else{return false};return values.isRegularFile==true && values.isSymbolicLink != true}
    private func text(_ url:URL)throws->String {
        guard regular(url),let size=(try? FileManager.default.attributesOfItem(atPath:url.path)[.size]) as? NSNumber,size.int64Value<=16*1024*1024 else{throw TaskBrowserImportFailure.readFailed}
        return try String(contentsOf:url,encoding:.utf8)
    }
    func database(_ source:TaskBrowserImportDefinition,profile:String)->URL? {
        let root=source.root(home:home),directory=profile.hasPrefix("/") ? URL(fileURLWithPath:profile,isDirectory:true):root.appendingPathComponent(profile,isDirectory:true)
        let names=source.engine=="safari" ? ["Cookies.binarycookies"]:source.engine=="firefox" ? ["cookies.sqlite"]:["Network/Cookies","Cookies"]
        return names.map {directory.appendingPathComponent($0)}.first(where:regular)
    }
    static func firefoxProfiles(_ ini:String,root:URL)->[TaskBrowserImportProfile] {
        var result:[TaskBrowserImportProfile]=[],section:[String:String]?
        func flush() {
            defer{section=nil};guard let section,let path=section["path"],!path.isEmpty,!path.contains("\0"),section["isrelative"]==nil || ["0","1"].contains(section["isrelative"]!) else{return}
            let relative=section["isrelative"] != "0",absolute=path.hasPrefix("/"),resolved=(absolute ? URL(fileURLWithPath:path):root.appendingPathComponent(path)).standardizedFileURL
            guard relative ? !absolute && (resolved.path==root.path || resolved.path.hasPrefix(root.path+"/")):absolute else{return}
            let name=section["name"].map(TaskBrowserAnnotationText.trim).flatMap {$0.isEmpty ? nil:$0} ?? path
            result.append(.init(directory:relative ? normalizeRelative(path):resolved.path,name:name))
        }
        for line in ini.components(separatedBy:.newlines).map(TaskBrowserAnnotationText.trim) {
            if line.hasPrefix("[") {flush();section=line.range(of:#"^\[Profile\d+\]$"#,options:[.regularExpression,.caseInsensitive]) != nil ? [:]:nil;continue}
            guard section != nil,let separator=line.firstIndex(of:"=") else{continue};section?[TaskBrowserAnnotationText.trim(String(line[..<separator])).lowercased()]=TaskBrowserAnnotationText.trim(String(line[line.index(after:separator)...]))
        };flush();return result
    }
    private static func normalizeRelative(_ value:String)->String {
        let base=URL(fileURLWithPath:"/",isDirectory:true).appendingPathComponent(value).standardizedFileURL.path
        return base=="/" ? ".":String(base.dropFirst())
    }
    private static func safeSegment(_ value:String)->Bool {!value.isEmpty && ![".",".."].contains(value) && !value.contains("/") && !value.contains("\\") && !value.contains("\0")}
    func profiles(_ source:TaskBrowserImportDefinition)->[TaskBrowserImportProfile] {
        let root=source.root(home:home);var profiles:[TaskBrowserImportProfile]=[]
        if source.engine=="safari" {
            let library=root.deletingLastPathComponent(),metadata=library.appendingPathComponent("Safari/SafariTabs.db")
            let rows=(try? TaskBrowserCookieSQL(metadata).query("SELECT title,external_uuid FROM bookmarks WHERE parent=0 AND type=1 AND subtype=2 AND deleted=0 ORDER BY order_index")) ?? []
            let defaultRow=rows.first {$0["external_uuid"]?.text=="DefaultProfile"},name=defaultRow?["title"]?.text.trimmingCharacters(in:.whitespacesAndNewlines)
            profiles=[.init(directory:".",name:defaultRow==nil ? "Safari":name.flatMap {$0.isEmpty ? nil:$0} ?? "Personal")]
            let stores=library.appendingPathComponent("WebKit/WebsiteDataStore",isDirectory:true)
            for row in rows {guard let uuid=row["external_uuid"]?.text,UUID(uuidString:uuid) != nil else{continue};let name=row["title"]?.text.trimmingCharacters(in:.whitespacesAndNewlines);profiles.append(.init(directory:stores.appendingPathComponent(uuid.lowercased()+"/Cookies").path,name:name.flatMap {$0.isEmpty ? nil:$0} ?? uuid))}
            if rows.isEmpty {for uuid in ((try? FileManager.default.contentsOfDirectory(atPath:stores.path)) ?? []).filter({UUID(uuidString:$0) != nil}).sorted() {let path=stores.appendingPathComponent(uuid+"/Cookies").path;if database(source,profile:path) != nil {profiles.append(.init(directory:path,name:uuid))}}}
        }else if source.engine=="firefox" {
            let declared=(try? text(root.appendingPathComponent("profiles.ini"))).map {Self.firefoxProfiles($0,root:root)} ?? []
            profiles=declared.filter {database(source,profile:$0.directory) != nil}
            if profiles.isEmpty {profiles=((try? FileManager.default.contentsOfDirectory(atPath:root.appendingPathComponent("Profiles").path)) ?? []).filter(Self.safeSegment).sorted().map {.init(directory:"Profiles/"+$0,name:$0)}.filter {database(source,profile:$0.directory) != nil}}
        }else {
            if let raw=try? text(root.appendingPathComponent("Local State")),let value=(try? JSONSerialization.jsonObject(with:Data(raw.utf8))) as? [String:Any],let object=value["profile"] as? [String:Any],let cache=object["info_cache"] as? [String:[String:Any]] {
                profiles=cache.keys.filter(Self.safeSegment).sorted().map {directory in let name=(cache[directory]?["name"] as? String).map(TaskBrowserAnnotationText.trim);return .init(directory:directory,name:name.flatMap {$0.isEmpty ? nil:$0} ?? directory)}
            }
            if profiles.isEmpty {profiles=((try? FileManager.default.contentsOfDirectory(atPath:root.path)) ?? []).filter(Self.safeSegment).sorted().filter {database(source,profile:$0) != nil}.map {.init(directory:$0,name:$0)}}
        }
        if source.engine != "safari" {profiles=profiles.map {profile in var value=profile;if let path=database(source,profile:profile.directory),let sql=try? TaskBrowserCookieSQL(path) {value.cookieCount=try? Int(sql.query(source.engine=="firefox" ? "SELECT count(*) AS count FROM moz_cookies WHERE originAttributes=''":"SELECT count(*) AS count FROM cookies",limit:1).first?["count"]?.number ?? 0)};return value}}
        return profiles
    }
    func sources()async->[TaskBrowserImportSource] {
        var result:[TaskBrowserImportSource]=[]
        for source in TaskBrowserImportDefinition.all {
            let root=source.root(home:home),profiles=self.profiles(source),installed=profiles.contains {database(source,profile:$0.directory) != nil}
            let unavailable:TaskBrowserImportFailure? = !installed ? .notInstalled:await running(source,root:root) ? .browserRunning:nil
            result.append(.init(definition:source,profiles:profiles,unavailable:unavailable))
        };return result
    }
    private func running(_ source:TaskBrowserImportDefinition,root:URL)async->Bool {if let running {return await running(source,root)};return TaskBrowserImportProcesses.running(source,root:root,profiles:profiles(source))}
    func read(sourceID:String,profileDirectory:String)async throws->TaskBrowserCookieReadBatch {
        guard let source=TaskBrowserImportDefinition.all.first(where:{$0.id==sourceID}) else{throw TaskBrowserImportFailure.readFailed};let root=source.root(home:home)
        let known=profiles(source);guard known.contains(where:{database(source,profile:$0.directory) != nil}) else{throw TaskBrowserImportFailure.notInstalled}
        guard !(await running(source,root:root)) else{throw TaskBrowserImportFailure.browserRunning}
        guard known.contains(where:{$0.directory==profileDirectory}) else{throw TaskBrowserImportFailure.unknownSourceProfile}
        guard let path=database(source,profile:profileDirectory),let size=(try? FileManager.default.attributesOfItem(atPath:path.path)[.size]) as? NSNumber,size.int64Value<=512*1024*1024 else{throw TaskBrowserImportFailure.readFailed}
        do {
            let batch:TaskBrowserCookieReadBatch
            if source.engine=="safari" {batch=try TaskBrowserCookieDatabases.safari(Data(contentsOf:path))}
            else {
                let temp=temporary.appendingPathComponent("FridayCookieImport-"+UUID().uuidString,isDirectory:true);try FileManager.default.createDirectory(at:temp,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700]);defer{try? FileManager.default.removeItem(at:temp)}
                let snapshot=temp.appendingPathComponent("cookies.sqlite");try TaskBrowserCookieSQL(path).snapshot(to:snapshot);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:snapshot.path)
                let sql=try TaskBrowserCookieSQL(snapshot)
                if source.engine=="firefox" {batch=try TaskBrowserCookieDatabases.firefox(sql)}else{var secret=try key(source);defer{secret.resetBytes(in:0..<secret.count)};var derived=try TaskBrowserCookieCrypto.derive(secret);defer{derived.resetBytes(in:0..<derived.count)};batch=try TaskBrowserCookieDatabases.chromium(sql,key:derived)}
            }
            guard !(await running(source,root:root)) else{throw TaskBrowserImportFailure.browserRunning};return batch
        }catch let failure as TaskBrowserImportFailure {throw failure}catch {let error=error as NSError;if error.domain==NSPOSIXErrorDomain && error.code==Int(EPERM) || error.userInfo[NSUnderlyingErrorKey].flatMap({($0 as? NSError)?.code})==Int(EPERM) {throw TaskBrowserImportFailure.needsFullDiskAccess};throw TaskBrowserImportFailure.readFailed}
    }
}
#endif
