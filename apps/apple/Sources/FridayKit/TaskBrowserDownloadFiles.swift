import Foundation

enum TaskBrowserDownloadFiles {
    static func name(_ value:String)->String {
        let last=value.replacingOccurrences(of:"\\",with:"/").split(separator:"/",omittingEmptySubsequences:false).last.map(String.init) ?? ""
        let clean=last.components(separatedBy:.controlCharacters).joined()
        return clean.isEmpty || clean=="." || clean==".." ? "download":String(decoding:clean.utf8.prefix(240),as:UTF8.self)
    }
    static func temporary(_ name:String)throws->URL {
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("FridayDownload-"+UUID().uuidString,isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        return directory.appendingPathComponent(Self.name(name))
    }
    static func install(_ source:URL,to destination:URL)throws {
        let manager=FileManager.default,staged=destination.deletingLastPathComponent().appendingPathComponent(".friday-download-"+UUID().uuidString)
        if (try? destination.resourceValues(forKeys:[.isDirectoryKey]).isDirectory)==true {throw CocoaError(.fileWriteInvalidFileName)}
        let access=destination.startAccessingSecurityScopedResource();defer {if access {destination.stopAccessingSecurityScopedResource()};try? manager.removeItem(at:staged)}
        try manager.copyItem(at:source,to:staged)
        if manager.fileExists(atPath:destination.path) {_ = try manager.replaceItemAt(destination,withItemAt:staged)}
        else {try manager.moveItem(at:staged,to:destination)}
    }
    static func removeTemporary(_ url:URL) {
        let parent=url.deletingLastPathComponent()
        guard parent.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL==FileManager.default.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL else{return}
        guard parent.lastPathComponent.hasPrefix("FridayDownload-") || parent.lastPathComponent.hasPrefix("FridayBrowser-") else{return}
        try? FileManager.default.removeItem(at:parent)
    }
}
