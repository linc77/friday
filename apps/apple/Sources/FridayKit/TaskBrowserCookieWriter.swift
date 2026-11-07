#if os(macOS)
import Foundation
import WebKit

struct TaskBrowserCookieImportResult:Equatable {
    let imported:Int;let skipped:Int;let skippedDomains:[String];let persisted:Bool
}
@MainActor protocol TaskBrowserCookieSink:AnyObject {
    func set(_ cookie:HTTPCookie)async throws
    func flush()async->Bool
}
@MainActor final class TaskBrowserCookieFlushReply {
    private var continuation:CheckedContinuation<Bool,Never>?
    init(_ continuation:CheckedContinuation<Bool,Never>) {self.continuation=continuation}
    func finish(_ value:Bool) {let current=continuation;continuation=nil;current?.resume(returning:value)}
}
@MainActor final class TaskBrowserWebKitCookieSink:TaskBrowserCookieSink {
    let store:WKHTTPCookieStore
    init(_ store:WKHTTPCookieStore) {self.store=store}
    func set(_ cookie:HTTPCookie)async throws {await withCheckedContinuation {continuation in store.setCookie(cookie){continuation.resume()}}}
    func flush()async->Bool {
        await withCheckedContinuation {continuation in
            let reply=TaskBrowserCookieFlushReply(continuation)
            let available=TaskBrowserNativeControls.flushCookies(store){Task { @MainActor in reply.finish(true)}}
            if !available {reply.finish(false)}else{Task { @MainActor in try? await Task.sleep(for:.seconds(8));reply.finish(false)}}
        }
    }
}
enum TaskBrowserCookieWriter {
    static func cookie(_ source:TaskBrowserImportedCookie)->HTTPCookie? {
        guard let url=URL(string:source.url),["http","https"].contains(url.scheme ?? ""),let host=url.host,!host.isEmpty,url.user==nil,url.password==nil,
              !source.name.isEmpty,source.name.utf8.count<=4096,source.value.utf8.count<=65536,source.path.hasPrefix("/"),source.path.utf8.count<=4096,
              source.name.rangeOfCharacter(from:CharacterSet.controlCharacters.union(CharacterSet(charactersIn:" ()<>@,;:\\\"/[]?={}\t")))==nil,
              source.value.rangeOfCharacter(from:.controlCharacters)==nil,source.path.rangeOfCharacter(from:.controlCharacters)==nil else{return nil}
        if source.name.hasPrefix("__Secure-"),!source.secure {return nil}
        if source.name.hasPrefix("__Host-"),!source.secure || source.path != "/" || source.domain != nil {return nil}
        if source.sameSite=="no_restriction",!source.secure {return nil}
        if let domain=source.domain,(!domain.hasPrefix(".") || domain.dropFirst().lowercased() != host.lowercased()) {return nil}
        var properties:[HTTPCookiePropertyKey:Any]=[.originURL:url,.name:source.name,.value:source.value,.path:source.path,.version:0]
        if let domain=source.domain {properties[.domain]=domain}
        if source.secure {properties[.secure]="TRUE"};if source.httpOnly {properties[HTTPCookiePropertyKey("HttpOnly")]="TRUE"}
        if let expiry=source.expirationDate {guard expiry.isFinite else{return nil};properties[.expires]=Date(timeIntervalSince1970:expiry)}
        if source.sameSite=="lax" {properties[.sameSitePolicy]="Lax"}else if source.sameSite=="strict" {properties[.sameSitePolicy]="Strict"}else if source.sameSite=="no_restriction" {properties[.sameSitePolicy]="None"}
        return HTTPCookie(properties:properties)
    }
    @MainActor static func write(_ batch:TaskBrowserCookieReadBatch,to sink:TaskBrowserCookieSink)async->TaskBrowserCookieImportResult {
        var imported=0,skipped=batch.skipped,domains=batch.skippedDomains
        for source in batch.cookies {
            guard let cookie=cookie(source) else{skipped+=1;if !domains.contains(source.bareHost) {domains.append(source.bareHost)};continue}
            do {try await sink.set(cookie);imported+=1}catch{skipped+=1;if !domains.contains(source.bareHost) {domains.append(source.bareHost)}}
        }
        let persisted=imported==0 ? true:await sink.flush()
        return .init(imported:imported,skipped:skipped,skippedDomains:Array(domains.prefix(20)),persisted:persisted)
    }
}
#endif
