/*
Adapted from T3 Code 8cd9641f packages/client-runtime/src/pullRequestMarkdown.ts.
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
import Foundation

struct TaskChangeRequestMarkdownSegment: Equatable, Identifiable {
    enum Content: Equatable { case markdown(String), image(String), video(String) }
    let id: String; let content: Content
}
enum TaskChangeRequestMarkdownSegments {
    private static let fence = try! NSRegularExpression(pattern: #"^\s{0,3}((?:`{3,})|(?:~{3,}))(.*)$"#)
    private static let indented = try! NSRegularExpression(pattern: #"^(?: {4}|\t)"#)
    private static let bare = try! NSRegularExpression(pattern: #"^<?(https?://\S+?)>?$"#)
    private static let link = try! NSRegularExpression(pattern: #"^\[[^\]]*\]\((https?://[^\s)]+)\)$"#)
    private static let image = try! NSRegularExpression(pattern: #"\.(?:png|jpe?g|gif|webp|avif|heic|heif|svg)(?:$|[?#])"#, options: .caseInsensitive)
    private static let video = try! NSRegularExpression(pattern: #"\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])"#, options: .caseInsensitive)
    private static let asset = try! NSRegularExpression(pattern: #"^https://github\.com/user-attachments/assets/[A-Za-z0-9_-]+$"#, options: .caseInsensitive)
    private static let videoStart = try! NSRegularExpression(pattern: #"^\s*<video\b"#, options: .caseInsensitive)
    private static let videoEnd = try! NSRegularExpression(pattern: #"</video>\s*$"#, options: .caseInsensitive)
    private static let videoSource = try! NSRegularExpression(pattern: #"<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']"#, options: .caseInsensitive)
    private static func groups(_ expression: NSRegularExpression, _ text: String) -> [String]? {
        guard let result = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (0..<result.numberOfRanges).map { Range(result.range(at: $0), in: text).map { String(text[$0]) } ?? "" }
    }
    private static func matches(_ expression: NSRegularExpression, _ text: String) -> Bool { groups(expression, text) != nil }
    private static func web(_ text: String) -> Bool {
        guard let url = URL(string: text) else { return false }; return ["https", "http"].contains(url.scheme?.lowercased() ?? "")
    }
    static func split(_ body: String) -> [TaskChangeRequestMarkdownSegment] {
        var segments: [TaskChangeRequestMarkdownSegment] = [], markdown: [String] = [], openFence: String?
        let lines = body.components(separatedBy: "\n")
        func flush() {
            let text = markdown.joined(separator: "\n").replacingOccurrences(of: #"^\n+"#, with: "", options: .regularExpression).replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
            markdown = []
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { segments.append(.init(id: "markdown:\(segments.count)", content: .markdown(text))) }
        }
        var index = 0
        while index < lines.count {
            let line = lines[index]; defer { index += 1 }
            if let found = groups(fence, line) {
                let marker = found[1]
                if let current = openFence {
                    if marker.first == current.first && marker.count >= current.count && found[2].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { openFence = nil }
                } else { openFence = marker }
                markdown.append(line); continue
            }
            if openFence != nil || matches(indented, line) { markdown.append(line); continue }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if let url = groups(bare, trimmed)?[1] ?? groups(link, trimmed)?[1], web(url) {
                if matches(video, url) || matches(asset, url) { flush(); segments.append(.init(id: "attachment:\(segments.count)", content: .video(url))); continue }
                if matches(image, url) { flush(); segments.append(.init(id: "attachment:\(segments.count)", content: .image(url))); continue }
            }
            guard matches(videoStart, line) else { markdown.append(line); continue }
            let last = min(index + 8, lines.count) - 1; var cursor = index
            while cursor < last && !matches(videoEnd, lines[cursor]) { cursor += 1 }
            if matches(videoEnd, lines[cursor]), let source = groups(videoSource, lines[index...cursor].joined(separator: "\n"))?[1], web(source) {
                flush(); segments.append(.init(id: "attachment:\(segments.count)", content: .video(source))); index = cursor
            } else { markdown.append(line) }
        }
        flush(); return segments
    }
}
