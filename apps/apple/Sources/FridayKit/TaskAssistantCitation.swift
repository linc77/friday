import Foundation

struct TaskAssistantCitationOccurrence { let citation: TaskAssistantCitation; let range: NSRange; let source: String }
extension TaskAssistantCitation {
    static let hrefPrefix = "t3-citation://v1/"
    static let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000B}\u{000C}\u{0020}\u{00A0}\u{FEFF}\u{000A}\u{000D}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}")
    static let whitespacePattern = #"[\u0009\u000B\u000C\u0020\u00A0\uFEFF\u000A\u000D\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+"#
    var valid: Bool {
        version == 1 && [environmentId,threadId,messageId].allSatisfy { !$0.isEmpty && $0.utf16.count <= 512 } &&
        !text.trimmingCharacters(in: Self.whitespace).isEmpty && text.utf16.count <= 8000 &&
        start >= 0 && end > start && end <= 9_007_199_254_740_991 && prefix.utf16.count <= 32 && suffix.utf16.count <= 32 && (comment?.utf16.count ?? 0) <= 8000
    }
    static func normalize(_ text: String) -> String { text.replacingOccurrences(of: whitespacePattern, with: " ", options: .regularExpression) }
    func withComment(_ comment: String) -> Self { var next = self; let value = comment.trimmingCharacters(in: Self.whitespace); next.comment = value.isEmpty ? nil : value; return next }
    static func encode(_ text: String, form: Bool) -> String {
        let allowed = Set((form ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._" : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~").utf8)
        return text.utf8.map { byte in allowed.contains(byte) ? String(UnicodeScalar(byte)) : form && byte == 32 ? "+" : String(format:"%%%02X",byte) }.joined()
    }
    static func decodeForm(_ text: String) -> String {
        let bytes = Array(text.utf8); var result: [UInt8] = [], index = 0
        while index < bytes.count {
            if bytes[index] == 43 { result.append(32) }
            else if bytes[index] == 37, index + 2 < bytes.count, let value = UInt8(String(decoding: bytes[(index+1)...(index+2)], as: UTF8.self), radix:16) { result.append(value); index += 2 }
            else { result.append(bytes[index]) }; index += 1
        }
        return String(decoding:result,as:UTF8.self)
    }
    var href: String {
        var query = [("text",text),("start",String(start)),("end",String(end)),("prefix",prefix),("suffix",suffix)]
        if let comment { query.append(("comment",comment)) }
        return Self.hrefPrefix + [environmentId,threadId,messageId].map { Self.encode($0,form:false) }.joined(separator:"/") + "?" + query.map { $0.0 + "=" + Self.encode($0.1,form:true) }.joined(separator:"&")
    }
    var token: String { "[Assistant quote](" + href + ")" }
    var label: String {
        let trimmed = comment?.trimmingCharacters(in: Self.whitespace)
        let value = Self.normalize(trimmed?.isEmpty == false ? trimmed! : text)
        return value.utf16.count > 64 ? String(decoding:Array(value.utf16.prefix(64)),as:UTF16.self) + "…" : value
    }
    static func parse(_ href: String) -> Self? {
        guard href.hasPrefix(hrefPrefix), href.utf16.count <= 160_000 else { return nil }
        let source = href.replacingOccurrences(of: #"[\t\r\n]"#,with:"",options:.regularExpression)
        let hash = source.firstIndex(of:"#")
        if let hash, source.index(after:hash) != source.endIndex { return nil }
        let body = String(source.dropFirst(hrefPrefix.count).prefix { $0 != "#" }), pieces = body.split(separator:"?",maxSplits:1,omittingEmptySubsequences:false)
        guard pieces.count == 2 else { return nil }
        var parts: [String] = []
        for raw in pieces[0].split(separator:"/",omittingEmptySubsequences:false) {
            guard let part = String(raw).removingPercentEncoding else { return nil }
            if part == "." { continue }; if part == ".." { if !parts.isEmpty { parts.removeLast() }; continue }; parts.append(part)
        }
        guard parts.count == 3 else { return nil }
        var query: [String:String] = [:], count = 0
        for entry in pieces[1].split(separator:"&") {
            let values = entry.split(separator:"=",maxSplits:1,omittingEmptySubsequences:false)
            let key = decodeForm(String(values[0])); guard query[key] == nil else { return nil }
            query[key] = values.count == 2 ? decodeForm(String(values[1])) : ""; count += 1
        }
        guard count == 5 + (query["comment"] == nil ? 0 : 1), ["text","start","end","prefix","suffix"].allSatisfy({ query[$0] != nil }),
              let startText = query["start"], let endText = query["end"], startText.range(of:#"^[0-9]{1,16}$"#,options:.regularExpression) != nil,
              endText.range(of:#"^[0-9]{1,16}$"#,options:.regularExpression) != nil, let start = Int(startText), let end = Int(endText) else { return nil }
        let value = Self(environmentId:parts[0],threadId:parts[1],messageId:parts[2],text:query["text"]!,start:start,end:end,prefix:query["prefix"]!,suffix:query["suffix"]!,comment:query["comment"])
        return value.valid ? value : nil
    }
    static func occurrences(_ text: String) -> [TaskAssistantCitationOccurrence] {
        guard let regex = try? NSRegularExpression(pattern:#"\[Assistant quote\]\((t3-citation://v1/[^\s)]{1,159983})\)"#) else { return [] }
        let value = text as NSString
        return regex.matches(in:text,range:NSRange(location:0,length:value.length)).compactMap { match in
            guard let citation = parse(value.substring(with:match.range(at:1))) else { return nil }
            return TaskAssistantCitationOccurrence(citation:citation,range:match.range,source:value.substring(with:match.range))
        }
    }
    static func make(environment: String, task: String, message: String, source: String, range: NSRange) -> Self? {
        let value = source as NSString; guard range.location != NSNotFound, range.length > 0, NSMaxRange(range) <= value.length else { return nil }
        let quote = value.substring(with:range); guard !quote.trimmingCharacters(in:whitespace).isEmpty else { return nil }
        let normalized = normalize(source) as NSString
        var start = normalize(value.substring(to:range.location)).utf16.count
        if range.location > 0, range.location < value.length, whitespace.characterIsMember(value.character(at:range.location-1)), whitespace.characterIsMember(value.character(at:range.location)) { start -= 1 }
        let end = normalize(value.substring(to:NSMaxRange(range))).utf16.count
        var before = max(0,start-32), after = min(normalized.length,end+32)
        if before > 0, before < normalized.length, (0xD800...0xDBFF).contains(normalized.character(at:before-1)), (0xDC00...0xDFFF).contains(normalized.character(at:before)) { before += 1 }
        if after > 0, after < normalized.length, (0xD800...0xDBFF).contains(normalized.character(at:after-1)), (0xDC00...0xDFFF).contains(normalized.character(at:after)) { after -= 1 }
        return Self(environmentId:environment,threadId:task,messageId:message,text:quote,start:start,end:end,prefix:normalized.substring(with:NSRange(location:before,length:start-before)),suffix:normalized.substring(with:NSRange(location:end,length:after-end)))
    }
    func find(in source: String) -> NSRange? {
        let value = Self.normalize(source) as NSString, quote = Self.normalize(text), before = Self.normalize(prefix), after = Self.normalize(suffix)
        let size = (quote as NSString).length; guard size > 0 else { return nil }
        func context(_ start: Int) -> Bool {
            let end = start + size, prefixSize = (before as NSString).length, suffixSize = (after as NSString).length
            return value.substring(with:NSRange(location:max(0,start-prefixSize),length:min(start,prefixSize))).utf16.elementsEqual(before.utf16) &&
                value.substring(with:NSRange(location:end,length:min(value.length-end,suffixSize))).utf16.elementsEqual(after.utf16)
        }
        var match: NSRange?, only: NSRange?, count = 0, offset = 0
        while offset <= value.length - size {
            let range = value.range(of:quote,options:.literal,range:NSRange(location:offset,length:value.length-offset)); if range.location == NSNotFound { break }
            count += 1; only = range
            if context(range.location) { if let match, match.location != range.location { return nil }; match = range }
            offset = range.location + 1
        }
        return match ?? (count == 1 ? only : nil)
    }
    func rawRange(in source: String) -> NSRange? {
        guard let found = find(in:source) else { return nil }
        let text = source as NSString
        func offset(_ normalized: Int) -> Int {
            var count = 0, whitespaceRun = false
            for index in 0..<text.length {
                let space = Self.whitespace.characterIsMember(text.character(at:index))
                if count == normalized, !space || !whitespaceRun { return index }
                if !space || !whitespaceRun { count += 1 }; whitespaceRun = space
            }; return text.length
        }
        let start = offset(found.location), end = offset(NSMaxRange(found)); return NSRange(location:start,length:max(0,end-start))
    }
}
private extension CharacterSet {
    func characterIsMember(_ value: unichar) -> Bool { UnicodeScalar(value).map(contains) ?? false }
}
extension TaskContextInsertion {
    func shouldInsert(in text: String) -> Bool {
        if alreadyInserted == true { return false }
        if plainText != nil {
            guard let replacing, replacing.range.location >= 0, NSMaxRange(replacing.range) <= (text as NSString).length else { return false }
            return (text as NSString).substring(with: replacing.range) == replacing.source
        }
        if let citation { return TaskAssistantCitation.occurrences(text).filter { $0.citation.href == citation.href }.count <= previousOccurrences }
        return reference.map { reference in TaskContextDocument.occurrences(text).filter { $0.id == reference.id }.count <= previousOccurrences } ?? false
    }
}
