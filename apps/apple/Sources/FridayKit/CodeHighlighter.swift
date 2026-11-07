import Foundation
import JavaScriptCore

struct CodeHighlight: Decodable, Sendable {
    struct Token: Decodable, Sendable { let text: String; let color: String; let style: Int }
    let foreground: String; let background: String; let language: String; let lines: [[Token]]
    var text: String { lines.map { $0.map(\.text).joined() }.joined(separator: "\n") }
    var tokens: [Token] {
        lines.enumerated().flatMap { index, line in index == 0 ? line : [Token(text: "\n", color: foreground, style: 0)] + line }
    }
}

/// Shiki/Oniguruma runs off the main thread with the same bundled grammars and
/// Pierre themes as T3. Source strings are arguments, never evaluated scripts.
final class CodeHighlighter: @unchecked Sendable {
    static let shared = CodeHighlighter()
    private struct Key: Hashable { let text: String; let language: String; let dark: Bool }
    private struct Cached { let value: CodeHighlight; let bytes: Int }
    private let queue = DispatchQueue(label: "Friday.code-highlighting", qos: .userInitiated)
    private var context: JSContext?
    private var unavailable = false
    private var cache: [Key: Cached] = [:]
    private var order: [Key] = []
    private var bytes = 0
    private var pending: [Key: [CheckedContinuation<CodeHighlight?, Never>]] = [:]

    func highlight(_ text: String, language: String, dark: Bool) async -> CodeHighlight? {
        guard !Task.isCancelled, text.utf8.count <= 1_048_576 else { return nil }
        let key = Key(text: text, language: language, dark: dark)
        return await withCheckedContinuation { continuation in
            queue.async { [self] in
                if let saved = cache[key] {
                    order.removeAll { $0 == key }; order.append(key); continuation.resume(returning: saved.value); return
                }
                if pending[key] != nil { pending[key]!.append(continuation); return }
                guard pending.count < 64, let context = runtime() else { continuation.resume(returning: nil); return }
                pending[key] = [continuation]
                let complete: @convention(block) (String) -> Void = { [weak self] raw in
                    self?.queue.async { [weak self] in self?.finish(key, raw: raw) }
                }
                context.exception = nil
                guard let callback = JSValue(object: complete, in: context) else { finish(key, raw: ""); return }
                context.objectForKeyedSubscript("fridayHighlight")?.call(withArguments: [text, language, dark, callback])
                if context.exception != nil { finish(key, raw: "") }
                queue.asyncAfter(deadline: .now() + 5) { [weak self] in self?.finish(key, raw: "") }
            }
        }
    }
    private func runtime() -> JSContext? {
        if let context { return context }; if unavailable { return nil }; unavailable = true
        guard let url = Bundle.module.url(forResource: "CodeHighlighter", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8), let value = JSContext(),
              value.objectForKeyedSubscript("WebAssembly")?.isUndefined == false else { return nil }
        value.evaluateScript(source)
        guard value.exception == nil, value.objectForKeyedSubscript("fridayHighlight")?.isUndefined == false else { return nil }
        context = value; return value
    }
    private func finish(_ key: Key, raw: String) {
        guard let waiting = pending.removeValue(forKey: key) else { return }
        let value = try? JSONDecoder().decode(CodeHighlight.self, from: Data(raw.utf8))
        let result = value?.text == key.text ? value : nil
        if let result {
            let cost = raw.utf8.count * 2 + key.text.utf8.count * 3
            if cost <= 50 * 1024 * 1024 {
                cache[key] = Cached(value: result, bytes: cost); order.append(key); bytes += cost
                while order.count > 500 || bytes > 50 * 1024 * 1024 {
                    let first = order.removeFirst(); if let removed = cache.removeValue(forKey: first) { bytes -= removed.bytes }
                }
            }
        }
        for continuation in waiting { continuation.resume(returning: result) }
    }
}
