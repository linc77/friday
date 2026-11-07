import Foundation
import CryptoKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct TaskBrowserArtifact:Codable,Equatable,Identifiable {
    let id:String;let name:String;let recording:Bool;let createdAt:Date
    var recovered:Bool?=nil
}
struct TaskBrowserArtifactStore {
    static let saved=Notification.Name("friday.browser.artifact.saved")
    let directory:URL
    init(scope:String,root:URL?=nil)throws {
        let root=try root ?? FileManager.default.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true).appendingPathComponent("Friday/BrowserArtifacts",isDirectory:true)
        let workspace=Bundle.main.bundleIdentifier ?? "friday",hash=SHA256.hash(data:Data((workspace+"\n"+scope).utf8)).map {String(format:"%02x",$0)}.joined()
        directory=root.appendingPathComponent(hash,isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
    }
    func url(_ artifact:TaskBrowserArtifact)throws->URL {
        guard artifact.id.range(of:"^[a-f0-9-]{36}$",options:.regularExpression) != nil,artifact.name==(artifact.name as NSString).lastPathComponent,!artifact.name.contains("\\"),artifact.name.hasSuffix(artifact.recording ? ".mp4":".png") else{throw ConnectionError.message("预览文件无效")}
        let url=directory.appendingPathComponent(artifact.id,isDirectory:true).appendingPathComponent(artifact.name)
        for path in [directory,url.deletingLastPathComponent(),url] {if (try? FileManager.default.destinationOfSymbolicLink(atPath:path.path)) != nil {throw ConnectionError.message("预览文件无效")}}
        guard url.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(directory.resolvingSymlinksInPath().path+"/") else{throw ConnectionError.message("预览文件无效")};return url
    }
    func prepare(page:String,recording:Bool)throws->TaskBrowserArtifact {
        let id=UUID(),value=TaskBrowserArtifact(id:id.uuidString.lowercased(),name:TaskBrowserCapturePolicy.fileName(page:page,recording:recording,id:id),recording:recording,createdAt:Date())
        let folder=try url(value).deletingLastPathComponent();try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700]);return value
    }
    func save(_ data:Data,page:String)throws->TaskBrowserArtifact {
        let artifact=try prepare(page:page,recording:false)
        do {try data.write(to:url(artifact),options:.atomic);try commit(artifact);return artifact}catch{remove(artifact);throw error}
    }
    func commit(_ artifact:TaskBrowserArtifact)throws {
        let file=try url(artifact),attributes=try FileManager.default.attributesOfItem(atPath:file.path)
        let metadata=file.deletingLastPathComponent().appendingPathComponent("metadata.json")
        guard (try? FileManager.default.destinationOfSymbolicLink(atPath:metadata.path))==nil else{throw ConnectionError.message("预览文件无效")}
        guard attributes[.type] as? FileAttributeType == .typeRegular,(attributes[.size] as? NSNumber)?.intValue ?? 0>0 else{throw ConnectionError.message("预览文件为空")}
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        try JSONEncoder().encode(artifact).write(to:metadata,options:.atomic)
        try? FileManager.default.removeItem(at:file.deletingLastPathComponent().appendingPathComponent("pending.json"))
        NotificationCenter.default.post(name:Self.saved,object:directory.path,userInfo:["artifact":artifact])
    }
    func beginRecording(_ artifact:TaskBrowserArtifact)throws->TaskBrowserRecordingLease {
        let folder=try url(artifact).deletingLastPathComponent(),pending=folder.appendingPathComponent("pending.json")
        guard (try? FileManager.default.destinationOfSymbolicLink(atPath:pending.path))==nil else{throw ConnectionError.message("预览文件无效")}
        let lease=try TaskBrowserRecordingLease(folder:folder)
        try JSONEncoder().encode(artifact).write(to:pending,options:.atomic);return lease
    }
    func interrupted()->[TaskBrowserArtifact] {
        let folders=(try? FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:nil)) ?? []
        return folders.compactMap {folder in
            guard (try? FileManager.default.destinationOfSymbolicLink(atPath:folder.path))==nil,
                  (try? FileManager.default.destinationOfSymbolicLink(atPath:folder.appendingPathComponent("pending.json").path))==nil,
                  let data=try? Data(contentsOf:folder.appendingPathComponent("pending.json")),data.count<8192,
                  let value=try? JSONDecoder().decode(TaskBrowserArtifact.self,from:data),value.recording,value.id==folder.lastPathComponent,
                  let file=try? url(value),FileManager.default.fileExists(atPath:file.path),
                  !FileManager.default.fileExists(atPath:folder.appendingPathComponent("metadata.json").path),
                  let lease=try? TaskBrowserRecordingLease(folder:folder) else{return nil}
            withExtendedLifetime(lease) {};return value
        }.sorted {$0.createdAt>$1.createdAt}
    }
    func recent()->[TaskBrowserArtifact] {
        guard let folders=try? FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:[.isDirectoryKey]) else{return []}
        return folders.compactMap {folder in
            guard (try? FileManager.default.destinationOfSymbolicLink(atPath:folder.path))==nil,(try? FileManager.default.destinationOfSymbolicLink(atPath:folder.appendingPathComponent("metadata.json").path))==nil else{return nil}
            guard let data=try? Data(contentsOf:folder.appendingPathComponent("metadata.json")),data.count<8192,let value=try? JSONDecoder().decode(TaskBrowserArtifact.self,from:data),folder.lastPathComponent==value.id,let file=try? url(value),FileManager.default.fileExists(atPath:file.path) else{return nil};return value
        }.sorted {$0.createdAt>$1.createdAt}.prefix(20).map {$0}
    }
    func remove(_ artifact:TaskBrowserArtifact) {if let file=try? url(artifact) {try? FileManager.default.removeItem(at:file.deletingLastPathComponent())}}
}
