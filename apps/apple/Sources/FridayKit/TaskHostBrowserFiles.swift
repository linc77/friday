import Foundation
import CryptoKit
import UniformTypeIdentifiers

struct TaskHostBrowserUploadBundle:Sendable {
    let url:URL;let contentType:String;let digest:String;let count:Int
    static let maximumBytes=100*1024*1024
    static let maximumFiles=20
    static func name(_ value:String)->String {
        let last=value.replacingOccurrences(of:"\\",with:"/").split(separator:"/",omittingEmptySubsequences:false).last.map(String.init) ?? ""
        let clean=last.components(separatedBy:.controlCharacters).joined().trimmingCharacters(in:.whitespacesAndNewlines)
        if clean.isEmpty || clean=="." || clean==".." {return "download"}
        var result="";for scalar in clean.unicodeScalars {if result.utf8.count+String(scalar).utf8.count<=240 {result.unicodeScalars.append(scalar)}};return result
    }
    static func types(_ accept:String)->[UTType] {
        var values:[UTType]=[]
        for entry in accept.split(separator:",").map({$0.trimmingCharacters(in:.whitespacesAndNewlines).lowercased()}) {
            let type:UTType?
            if entry.hasPrefix(".") {type=UTType(filenameExtension:String(entry.dropFirst()))}
            else if entry=="image/*" {type = .image}else if entry=="video/*" {type = .movie}else if entry=="audio/*" {type = .audio}else{type=UTType(mimeType:entry)}
            if let type,!values.contains(type) {values.append(type)}
        }
        return values.isEmpty ? [.item]:values
    }
    static func build(_ urls:[URL],multiple:Bool)throws->Self {
        guard urls.count<=maximumFiles,multiple || urls.count<=1 else{throw ConnectionError.message("所选文件数量超过网页允许的范围")}
        let target=try TaskBrowserDownloadFiles.temporary("upload.multipart"),directory=target.deletingLastPathComponent()
        try FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:directory.path)
        guard FileManager.default.createFile(atPath:target.path,contents:nil,attributes:[.posixPermissions:0o600]) else{throw CocoaError(.fileWriteUnknown)}
        let output=try FileHandle(forWritingTo:target);var success=false
        defer {try? output.close();if !success {TaskBrowserDownloadFiles.removeTemporary(target)}}
        let boundary="Friday-"+UUID().uuidString
        var manifest:[[Any]]=[],total=0
        for url in urls {
            try Task.checkCancellation()
            let access=url.startAccessingSecurityScopedResource();defer{if access {url.stopAccessingSecurityScopedResource()}}
            let values=try url.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey])
            guard values.isRegularFile==true,values.isSymbolicLink != true else{throw ConnectionError.message("请选择普通文件")}
            if let size=values.fileSize,size>maximumBytes-total {throw ConnectionError.message("上传文件合计不能超过 100 MiB")}
            let input=try FileHandle(forReadingFrom:url);defer{try? input.close()}
            let filename=name(url.lastPathComponent),mime=UTType(filenameExtension:url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            let encoded=filename.addingPercentEncoding(withAllowedCharacters:CharacterSet(charactersIn:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$&+-.^_`|~"))!
            try output.write(contentsOf:Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"files\"; filename=\"upload\"; filename*=UTF-8''\(encoded)\r\nContent-Type: \(mime)\r\n\r\n".utf8))
            var hash=SHA256(),size=0
            while let data=try input.read(upToCount:64*1024),!data.isEmpty {try Task.checkCancellation();total+=data.count;size+=data.count;guard total<=maximumBytes else{throw ConnectionError.message("上传文件合计不能超过 100 MiB")};hash.update(data:data);try output.write(contentsOf:data)}
            try output.write(contentsOf:Data("\r\n".utf8));manifest.append([Data(filename.utf8).base64EncodedString(),Data(mime.utf8).base64EncodedString(),size,hash.finalize().map{String(format:"%02x",$0)}.joined()])
        }
        try output.write(contentsOf:Data("--\(boundary)--\r\n".utf8));try output.synchronize()
        let json=try JSONSerialization.data(withJSONObject:manifest,options:[.withoutEscapingSlashes])
        let digest=SHA256.hash(data:json).map {String(format:"%02x",$0)}.joined();success=true
        return Self(url:target,contentType:"multipart/form-data; boundary="+boundary,digest:digest,count:urls.count)
    }
    func remove() {TaskBrowserDownloadFiles.removeTemporary(url)}
}

struct TaskHostBrowserTransferContext {
    let transport:TaskHostBrowserTransport
    let query:[String:String]
}

enum TaskHostBrowserClipboardText {
    static func chunks(_ text:String,limit:Int=8192)->[String] {
        var values:[String]=[],current="",length=0
        for scalar in text.unicodeScalars {
            let count=scalar.value>0xffff ? 2:1
            if length+count>limit,!current.isEmpty {values.append(current);current="";length=0}
            current.unicodeScalars.append(scalar);length+=count
        }
        if !current.isEmpty {values.append(current)};return values
    }
}
