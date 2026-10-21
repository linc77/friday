import Foundation
#if os(macOS)
import CommonCrypto
import CryptoKit
import SQLite3

enum TaskBrowserImportFailure:String,Error,LocalizedError {
    case notInstalled,browserRunning,needsKeychainApproval,keychainItemMissing,keychainUnavailable,needsFullDiskAccess,unknownSourceProfile,readFailed,sessionUnavailable,profileLimitReached,profileNotSaved
    var errorDescription:String? {String(localized:String.LocalizationValue("browser.import."+rawValue),bundle:.module)}
}
struct TaskBrowserImportedCookie:Codable,Equatable,Sendable {
    let url:String;let name:String;let value:String;let domain:String?;let path:String
    let secure:Bool;let httpOnly:Bool;let expirationDate:Double?;let sameSite:String
    static func make(host:String,name:String,value:String,path:String,secure:Bool,httpOnly:Bool,expires:Double?,sameSite:String)->Self {
        let bare=host.hasPrefix(".") ? String(host.dropFirst()):host,authority=bare.contains(":") && !bare.hasPrefix("[") ? "["+bare+"]":bare
        return .init(url:(secure ? "https://":"http://")+authority+path,name:name,value:value,domain:host.hasPrefix(".") ? host:nil,path:path,secure:secure,httpOnly:httpOnly,expirationDate:expires,sameSite:sameSite)
    }
    var bareHost:String {URL(string:url)?.host ?? domain.map {String($0.drop(while:{$0=="."}))} ?? ""}
}
struct TaskBrowserCookieReadBatch:Sendable {
    var cookies:[TaskBrowserImportedCookie]=[]
    var skipped=0
    var skippedDomains:[String]=[]
    mutating func skip(_ host:String) {skipped+=1;let value=host.hasPrefix(".") ? String(host.dropFirst()):host;if !skippedDomains.contains(value) {skippedDomains.append(value)}}
}

/// The macOS OSCrypt formats and cookie scope rules match the pinned T3 BrowserImport readers.
enum TaskBrowserCookieCrypto {
    static func derive(_ secret:Data)throws->Data {
        var key=Data(count:16),salt=Data("saltysalt".utf8)
        let status=key.withUnsafeMutableBytes {out in secret.withUnsafeBytes {password in salt.withUnsafeMutableBytes {salt in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),password.bindMemory(to:Int8.self).baseAddress,secret.count,salt.bindMemory(to:UInt8.self).baseAddress,salt.count,CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1),1003,out.bindMemory(to:UInt8.self).baseAddress,16)
        }}}
        guard status==kCCSuccess else{throw TaskBrowserImportFailure.readFailed};return key
    }
    static func decrypt(_ data:Data,key:Data,host:String,version:Int)->String? {
        if data.isEmpty {return ""}
        let prefix=String(data:data.prefix(3),encoding:.isoLatin1) ?? ""
        let plain:Data
        if prefix=="v10" {
            guard key.count==16,data.count>3,(data.count-3)%16==0 else{return nil}
            let payload=Data(data.dropFirst(3));var output=Data(count:payload.count+kCCBlockSizeAES128),written=0,iv=Data(repeating:0x20,count:16)
            let status=output.withUnsafeMutableBytes {out in key.withUnsafeBytes {key in iv.withUnsafeMutableBytes {iv in payload.withUnsafeBytes {input in
                CCCrypt(CCOperation(kCCDecrypt),CCAlgorithm(kCCAlgorithmAES),CCOptions(0),key.baseAddress,16,iv.baseAddress,input.baseAddress,payload.count,out.baseAddress,out.count,&written)
            }}}}
            guard status==kCCSuccess,written==payload.count,let padding=output.prefix(written).last,(1...16).contains(Int(padding)),output.prefix(written).suffix(Int(padding)).allSatisfy({$0==padding}) else{return nil}
            plain=Data(output.prefix(written-Int(padding)))
        }else if prefix=="v11" || prefix=="v20" {return nil}else{plain=data}
        if version>=24 {
            let hash=Data(SHA256.hash(data:Data(host.utf8)));guard plain.count>=32,plain.prefix(32)==hash else{return nil}
            return String(decoding:plain.dropFirst(32),as:UTF8.self)
        }
        return String(decoding:plain,as:UTF8.self)
    }
}

final class TaskBrowserCookieSQL {
    private var db:OpaquePointer?
    init(_ url:URL,readOnly:Bool=true)throws {
        let flags=(readOnly ? SQLITE_OPEN_READONLY:SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE)|SQLITE_OPEN_NOMUTEX
        guard sqlite3_open_v2(url.path,&db,flags,nil)==SQLITE_OK else{if let db {sqlite3_close(db)};db=nil;throw TaskBrowserImportFailure.readFailed}
        sqlite3_busy_timeout(db,3000)
    }
    deinit {if let db {sqlite3_close(db)}}
    enum Cell {case text(String),number(Double),blob(Data),null
        var text:String {if case .text(let value)=self {return value};return ""}
        var number:Double {if case .number(let value)=self {return value};if case .text(let value)=self {return Double(value) ?? 0};return 0}
        var data:Data {if case .blob(let value)=self {return value};return Data()}
        var isNull:Bool {if case .null=self {return true};return false}
        var numeric:Double? {if case .number(let value)=self {return value};if case .text(let value)=self {return Double(value)};return nil}
    }
    func query(_ sql:String,limit:Int=100_000)throws->[[String:Cell]] {
        var statement:OpaquePointer?;guard sqlite3_prepare_v2(db,sql,-1,&statement,nil)==SQLITE_OK,let statement else{throw TaskBrowserImportFailure.readFailed};defer{sqlite3_finalize(statement)}
        var rows:[[String:Cell]]=[],total=0
        while true {
            let status=sqlite3_step(statement);if status==SQLITE_DONE {break};guard status==SQLITE_ROW,rows.count<limit else{throw TaskBrowserImportFailure.readFailed}
            var row:[String:Cell]=[:]
            for i in 0..<sqlite3_column_count(statement) {
                let name=String(cString:sqlite3_column_name(statement,i));let count=Int(sqlite3_column_bytes(statement,i));total+=count;guard total<=128*1024*1024 else{throw TaskBrowserImportFailure.readFailed}
                switch sqlite3_column_type(statement,i) {
                case SQLITE_INTEGER,SQLITE_FLOAT:row[name] = .number(sqlite3_column_double(statement,i))
                case SQLITE_TEXT:row[name] = .text(String(decoding:UnsafeBufferPointer(start:sqlite3_column_text(statement,i),count:count),as:UTF8.self))
                case SQLITE_BLOB:row[name] = .blob(sqlite3_column_blob(statement,i).map {Data(bytes:$0,count:count)} ?? Data())
                default:row[name] = .null
                }
            };rows.append(row)
        };return rows
    }
    func snapshot(to url:URL)throws {
        let pages=try query("PRAGMA page_count",limit:1).first?.values.first?.number ?? 0,pageSize=try query("PRAGMA page_size",limit:1).first?.values.first?.number ?? 0
        guard pages*pageSize<=512*1024*1024 else{throw TaskBrowserImportFailure.readFailed}
        // Match T3's coherent read-only VACUUM INTO snapshot, including committed WAL pages.
        var statement:OpaquePointer?;guard sqlite3_prepare_v2(db,"VACUUM INTO ?",-1,&statement,nil)==SQLITE_OK,let statement else{throw TaskBrowserImportFailure.readFailed};defer{sqlite3_finalize(statement)}
        let status=url.path.withCString {sqlite3_bind_text(statement,1,$0,-1,unsafeBitCast(-1,to:sqlite3_destructor_type.self))}
        guard status==SQLITE_OK,sqlite3_step(statement)==SQLITE_DONE else{throw TaskBrowserImportFailure.readFailed}
    }
}
enum TaskBrowserCookieDatabases {
    static func chromium(_ sql:TaskBrowserCookieSQL,key:Data)throws->TaskBrowserCookieReadBatch {
        guard let rawVersion=try sql.query("SELECT value FROM meta WHERE key='version' LIMIT 1",limit:1).first?["value"]?.numeric,rawVersion.isFinite,rawVersion>=0,rawVersion<=Double(Int32.max),rawVersion.rounded()==rawVersion else{throw TaskBrowserImportFailure.readFailed}
        let version=Int(rawVersion),partition=version>=15 ? "top_frame_site_key":"'' AS top_frame_site_key"
        let rows=try sql.query("SELECT host_key,name,value,encrypted_value,path,expires_utc/1000000 AS expires_seconds,is_secure,is_httponly,samesite,\(partition) FROM cookies")
        var batch=TaskBrowserCookieReadBatch()
        for row in rows {
            let host=row["host_key"]?.text ?? "";guard row["top_frame_site_key"]?.text=="" else{batch.skip(host);continue}
            let encrypted=row["encrypted_value"]?.data ?? Data(),value=encrypted.isEmpty ? row["value"]?.text:TaskBrowserCookieCrypto.decrypt(encrypted,key:key,host:host,version:version)
            guard let value else{batch.skip(host);continue}
            let expires=row["expires_seconds"]?.number ?? 0,sameSite=row["samesite"]?.number ?? -1
            batch.cookies.append(.make(host:host,name:row["name"]?.text ?? "",value:value,path:row["path"]?.text ?? "/",secure:row["is_secure"]?.number==1,httpOnly:row["is_httponly"]?.number==1,expires:expires>0 ? expires-11_644_473_600:nil,sameSite:sameSite==0 ? "no_restriction":sameSite==1 ? "lax":sameSite==2 ? "strict":"unspecified"))
        };return batch
    }
    static func firefox(_ sql:TaskBrowserCookieSQL)throws->TaskBrowserCookieReadBatch {
        let version=Int(try sql.query("PRAGMA user_version",limit:1).first?["user_version"]?.number ?? 0),columns=Set(try sql.query("PRAGMA table_info(moz_cookies)").compactMap {$0["name"]?.text})
        let same=columns.contains("sameSite") ? "sameSite":"NULL AS sameSite",raw=(10...14).contains(version) && columns.contains("rawSameSite") ? "rawSameSite":"NULL AS rawSameSite"
        let rows=try sql.query("SELECT host,name,value,path,expiry,isSecure,isHttpOnly,\(same),\(raw) FROM moz_cookies WHERE originAttributes=''")
        var batch=TaskBrowserCookieReadBatch()
        for row in rows {
            let expiry=row["expiry"]?.number ?? 0,same=row["sameSite"],raw=row["rawSameSite"]
            let policy=same?.isNull != false || same?.number==1 && raw?.isNull==false && raw?.number==0 ? "unspecified":same?.number==0 ? "no_restriction":same?.number==1 ? "lax":same?.number==2 ? "strict":"unspecified"
            batch.cookies.append(.make(host:row["host"]?.text ?? "",name:row["name"]?.text ?? "",value:row["value"]?.text ?? "",path:row["path"]?.text ?? "/",secure:row["isSecure"]?.number==1,httpOnly:row["isHttpOnly"]?.number==1,expires:expiry>0 ? (version>=16 ? floor(expiry/1000):expiry):nil,sameSite:policy))
        };return batch
    }
    static func safari(_ data:Data)throws->TaskBrowserCookieReadBatch {
        func u32(_ value:Data,_ start:Int,_ big:Bool=false)throws->Int {guard start>=0,start+4<=value.count else{throw TaskBrowserImportFailure.readFailed};let bytes=Array(value[start..<start+4]);return (big ? bytes:Array(bytes.reversed())).reduce(0){($0<<8)|Int($1)}}
        func string(_ value:Data,_ start:Int)throws->String {guard start>=56,start<value.count else{throw TaskBrowserImportFailure.readFailed};let end=value[start...].firstIndex(of:0) ?? value.endIndex;return String(decoding:value[start..<end],as:UTF8.self)}
        guard data.count>=8,data.prefix(4)==Data("cook".utf8) else{throw TaskBrowserImportFailure.readFailed}
        let pages=try u32(data,4,true);guard pages<=(data.count-8)/4 else{throw TaskBrowserImportFailure.readFailed};var offset=8+pages*4,batch=TaskBrowserCookieReadBatch()
        for i in 0..<pages {
            let length=try u32(data,8+i*4,true);guard length>=12,length<=data.count-offset else{throw TaskBrowserImportFailure.readFailed}
            let page=data.subdata(in:offset..<offset+length);offset+=length;let count=try u32(page,4);guard count<=(page.count-12)/4 else{throw TaskBrowserImportFailure.readFailed}
            let table=12+count*4;var accepted:[Range<Int>]=[]
            for c in 0..<count {
                let start=try u32(page,8+c*4);guard start>=table,start<=page.count-56 else{throw TaskBrowserImportFailure.readFailed}
                let size=try u32(page,start);guard size>=56,size<=page.count-start,!accepted.contains(where:{$0.overlaps(start..<start+size)}) else{throw TaskBrowserImportFailure.readFailed};accepted.append(start..<start+size)
                let cookie=page.subdata(in:start..<start+size),flags=try u32(cookie,8),host=try string(cookie,u32(cookie,16)),name=try string(cookie,u32(cookie,20)),path=try string(cookie,u32(cookie,24)),value=try string(cookie,u32(cookie,28))
                let bits=cookie[40..<48].enumerated().reduce(UInt64(0)){$0|UInt64($1.element)<<($1.offset*8)},expiry=Double(bitPattern:bits);guard expiry.isFinite else{throw TaskBrowserImportFailure.readFailed}
                if host.isEmpty || name.isEmpty {continue}
                guard batch.cookies.count<100_000 else{throw TaskBrowserImportFailure.readFailed}
                batch.cookies.append(.make(host:host,name:name,value:value,path:path.isEmpty ? "/":path,secure:flags&1 != 0,httpOnly:flags&4 != 0,expires:expiry>0 ? floor(expiry)+978_307_200:nil,sameSite:"lax"))
            }
        }
        let trailer=data.count-offset;var validTrailer=trailer==0 || trailer==8
        if trailer>=12 {validTrailer=trailer==12+(try u32(data,offset+8,true))}
        guard validTrailer else{throw TaskBrowserImportFailure.readFailed};return batch
    }
}
#endif
