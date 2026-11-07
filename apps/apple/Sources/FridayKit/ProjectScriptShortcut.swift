/*
Adapted from T3 Code 8cd9641f packages/shared/src/keybindings.ts (single-chord parser).
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

struct ProjectScriptShortcut: Equatable {
    static func keyName(_ characters: String) -> String {
        if characters.unicodeScalars.count == 1, let value = characters.unicodeScalars.first?.value, (0xf704...0xf71b).contains(value) { return "f\(value - 0xf704 + 1)" }
        let named = ["\r":"enter", "\n":"enter", "\t":"tab", "\u{7f}":"backspace", "\u{8}":"backspace", "\u{1b}":"escape", "\u{f700}":"arrowup", "\u{f701}":"arrowdown", "\u{f702}":"arrowleft", "\u{f703}":"arrowright", "\u{f728}":"delete", "\u{f729}":"home", "\u{f72b}":"end", "\u{f72c}":"pageup", "\u{f72d}":"pagedown"]
        return named[characters] ?? characters.lowercased()
    }
    static func captured(key: String, command: Bool, control: Bool, shift: Bool, option: Bool) -> String? {
        let key = keyName(key)
        guard !key.isEmpty, !["command", "control", "shift", "alt", "meta"].contains(key), command || control || option || key.hasPrefix("f") && Int(key.dropFirst()).map({ (1...24).contains($0) }) == true else { return nil }
        var parts: [String] = []; if command { parts.append("meta") }; if control { parts.append("ctrl") }; if option { parts.append("alt") }; if shift { parts.append("shift") }; parts.append(key == " " ? "space" : key); return parts.joined(separator: "+")
    }
    let key: String
    let command: Bool
    let control: Bool
    let shift: Bool
    let option: Bool
    init?(_ value: String) {
        var tokens = value.lowercased().components(separatedBy: "+").map { $0.trimmingCharacters(in: .whitespaces) }
        var plus = false
        while tokens.last == "" { plus = true; tokens.removeLast() }
        if plus { tokens.append("+") }
        guard !tokens.isEmpty, !tokens.contains("") else { return nil }
        var key: String?, command = false, control = false, shift = false, option = false
        for token in tokens {
            switch token {
            case "cmd", "meta", "mod": command = true
            case "ctrl", "control": control = true
            case "shift": shift = true
            case "alt", "option": option = true
            default:
                guard key == nil else { return nil }
                key = token == "space" ? " " : token == "esc" ? "escape" : token
            }
        }
        guard let key else { return nil }; self.key = key; self.command = command; self.control = control; self.shift = shift; self.option = option
    }
    var label: String {
        (control ? "⌃" : "") + (option ? "⌥" : "") + (shift ? "⇧" : "") + (command ? "⌘" : "") + ([" ": "Space", "enter": "↩", "escape": "⎋", "arrowup": "↑", "arrowdown": "↓", "arrowleft": "←", "arrowright": "→", "backspace": "⌫", "delete": "⌦", "tab": "⇥"][key] ?? key.uppercased())
    }
    func matches(key: String, command: Bool, control: Bool, shift: Bool, option: Bool, repeating: Bool = false) -> Bool {
        !repeating && self.key == key.lowercased() && self.command == command && self.control == control && self.shift == shift && self.option == option
    }
}
