import SwiftUI

extension ProjectScriptShortcut {
    var equivalent: KeyEquivalent? {
        let named: [String: KeyEquivalent] = ["enter": .return, "escape": .escape, "tab": .tab, "backspace": .delete, "delete": .deleteForward, "home": .home, "end": .end, "pageup": .pageUp, "pagedown": .pageDown, "arrowup": .upArrow, "arrowdown": .downArrow, "arrowleft": .leftArrow, "arrowright": .rightArrow]
        if let value = named[key] { return value }
        if key.count == 1, let character = key.first { return KeyEquivalent(character) }
        if key.hasPrefix("f"), let number = Int(key.dropFirst()), (1...24).contains(number), let scalar = UnicodeScalar(0xf704 + number - 1) { return KeyEquivalent(Character(scalar)) }
        return nil
    }
    var modifiers: EventModifiers { var value: EventModifiers = []; if command { value.insert(.command) }; if control { value.insert(.control) }; if shift { value.insert(.shift) }; if option { value.insert(.option) }; return value }
}

struct ProjectScriptKeyboardActions: ViewModifier {
    let scripts: [ProjectScript]; let keybindings: [String: String]; let enabled: Bool; let run: (ProjectScript) -> Void
    func body(content: Content) -> some View {
        #if os(macOS)
        content.background(ScriptKeyReceiver(scripts: scripts, keybindings: keybindings, enabled: enabled, run: run).frame(width: 0, height: 0))
        #else
        content.background {
            ForEach(scripts) { script in
                if let raw = keybindings[script.id], let shortcut = ProjectScriptShortcut(raw), let key = shortcut.equivalent {
                    Button { run(script) } label: { EmptyView() }.keyboardShortcut(key, modifiers: shortcut.modifiers).disabled(!enabled).hidden().accessibilityHidden(true)
                }
            }
        }
        #endif
    }
}

struct ProjectScriptShortcutField: View {
    @Binding var value: String
    @State private var manualInput = false
    var body: some View {
        HStack(spacing: 10) {
            Text(friday: "快捷键").font(.caption).foregroundStyle(.secondary)
            #if os(macOS)
            ScriptKeyCapture(value: $value).frame(height: 24)
            #else
            if manualInput { TextField("mod+shift+k", text: $value).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled() }
            else { ScriptIOSKeyCapture(value: $value).frame(height: 30) }
            Button(friday: manualInput ? "按键录入" : "手动输入") { manualInput.toggle() }.buttonStyle(FridayButtonStyle(compact: true))
            #endif
            if !value.isEmpty { Button { value = "" } label: { FridaySymbolImage(systemName: "xmark") }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "清除快捷键")) }
        }
    }
}

#if os(macOS)
import AppKit

private enum ScriptKeys {
    static func key(_ event: NSEvent) -> String {
        let named: [UInt16: String] = [36:"enter",76:"enter",53:"escape",48:"tab",51:"backspace",117:"delete",115:"home",119:"end",116:"pageup",121:"pagedown",123:"arrowleft",124:"arrowright",125:"arrowdown",126:"arrowup"]
        if let key = named[event.keyCode] { return key }
        let functions: [UInt16] = [122,120,99,118,96,97,98,100,101,109,103,111,105,107,113,106,64,79,80,90]
        if let index = functions.firstIndex(of: event.keyCode) { return "f\(index + 1)" }
        let physical: [UInt16: String] = [50:"`",42:"\\",33:"[",30:"]",43:",",18:"1",19:"2",20:"3",21:"4",23:"5",22:"6",26:"7",28:"8",25:"9",29:"0",24:"=",27:"-",47:".",39:"'",41:";",44:"/"]
        return physical[event.keyCode] ?? ProjectScriptShortcut.keyName(event.charactersIgnoringModifiers ?? "")
    }
    static func chord(_ event: NSEvent) -> String? {
        let flags = event.modifierFlags
        return ProjectScriptShortcut.captured(key: key(event), command: flags.contains(.command), control: flags.contains(.control), shift: flags.contains(.shift), option: flags.contains(.option))
    }
    static func keys(_ event: NSEvent) -> Set<String> {
        let layout = ProjectScriptShortcut.keyName(event.charactersIgnoringModifiers ?? "")
        var values: Set<String> = [key(event), layout]
        if layout.range(of: "^[a-z]$", options: .regularExpression) == nil {
            let letters: [UInt16: String] = [0:"a",11:"b",8:"c",2:"d",14:"e",3:"f",5:"g",4:"h",34:"i",38:"j",40:"k",37:"l",46:"m",45:"n",31:"o",35:"p",12:"q",15:"r",1:"s",17:"t",32:"u",9:"v",13:"w",7:"x",16:"y",6:"z"]
            if let physical = letters[event.keyCode] { values.insert(physical) }
        }
        return values
    }
}

private struct ScriptKeyReceiver: NSViewRepresentable {
    let scripts: [ProjectScript]; let keybindings: [String: String]; let enabled: Bool; let run: (ProjectScript) -> Void
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSView { let view = NSView(); context.coordinator.view = view; context.coordinator.start(); return view }
    func updateNSView(_ view: NSView, context: Context) { context.coordinator.owner = self }
    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { coordinator.stop() }
    final class Coordinator {
        weak var view: NSView?; var owner: ScriptKeyReceiver?; var monitor: Any?
        func start() {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, let owner = self.owner, owner.enabled, let window = self.view?.window, event.window === window, NSApp.keyWindow === window, NSApp.modalWindow == nil, !event.isARepeat else { return event }
                if let editor = window.firstResponder as? NSTextInputClient, editor.hasMarkedText() { return event }
                let keys = ScriptKeys.keys(event), flags = event.modifierFlags
                guard let script = owner.scripts.first(where: { script in
                    guard let shortcut = owner.keybindings[script.id].flatMap(ProjectScriptShortcut.init) else { return false }
                    return keys.contains { shortcut.matches(key: $0, command: flags.contains(.command), control: flags.contains(.control), shift: flags.contains(.shift), option: flags.contains(.option)) }
                }) else { return event }
                owner.run(script); return nil
            }
        }
        func stop() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil; owner = nil }
    }
}

private struct ScriptKeyCapture: NSViewRepresentable {
    @Binding var value: String
    @Environment(\.isEnabled) private var enabled
    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField(); let cell = ScriptKeyCell(textCell: ""); cell.isEditable = true; cell.isScrollable = true; cell.isBezeled = true; cell.bezelStyle = .roundedBezel
        field.cell = cell; field.focusRingType = .default; field.placeholderString = "⌘⇧K"; field.font = .monospacedSystemFont(ofSize: 12, weight: .regular); return field
    }
    func updateNSView(_ field: NSTextField, context: Context) {
        field.isEnabled = enabled; field.stringValue = ProjectScriptShortcut(value)?.label ?? ""
        (field.cell as? ScriptKeyCell)?.editor.capture = { [weak field] event in
            guard enabled else { return false }
            if event.keyCode == 48 { return false }
            if event.keyCode == 51 || event.keyCode == 117 { value = "" }
            else if let chord = ScriptKeys.chord(event), !event.isARepeat { value = chord }
            field?.stringValue = ProjectScriptShortcut(value)?.label ?? ""; return true
        }
    }
    static func dismantleNSView(_ field: NSTextField, coordinator: ()) { (field.cell as? ScriptKeyCell)?.editor.capture = nil }
}
private final class ScriptKeyCell: NSTextFieldCell {
    let editor = ScriptKeyEditor()
    override func fieldEditor(for controlView: NSView) -> NSTextView? { editor.isFieldEditor = true; return editor }
}
private final class ScriptKeyEditor: NSTextView {
    var capture: ((NSEvent) -> Bool)?
    override func keyDown(with event: NSEvent) { if capture?(event) != true { super.keyDown(with: event) } }
    override func performKeyEquivalent(with event: NSEvent) -> Bool { capture?(event) == true || super.performKeyEquivalent(with: event) }
}
#endif

#if os(iOS)
import UIKit
private struct ScriptIOSKeyCapture: UIViewRepresentable {
    @Binding var value: String
    @Environment(\.isEnabled) private var enabled
    func makeUIView(context: Context) -> ScriptIOSKeyField {
        let field = ScriptIOSKeyField(); field.borderStyle = .roundedRect; field.placeholder = "⌘⇧K"; field.font = .monospacedSystemFont(ofSize: 13, weight: .regular); field.inputView = UIView(frame: .zero); return field
    }
    func updateUIView(_ field: ScriptIOSKeyField, context: Context) { field.isEnabled = enabled; field.text = ProjectScriptShortcut(value)?.label; field.capture = { if enabled { value = $0 } } }
    static func dismantleUIView(_ field: ScriptIOSKeyField, coordinator: ()) { field.capture = nil }
}
private final class ScriptIOSKeyField: UITextField {
    var capture: ((String) -> Void)?
    private var held = Set<Int>()
    override func insertText(_ text: String) {}
    override func deleteBackward() { capture?("") }
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var forwarded = Set<UIPress>()
        for press in presses {
            guard let key = press.key else { forwarded.insert(press); continue }
            let code = key.keyCode.rawValue
            if code == 0x2b { forwarded.insert(press); continue }
            guard held.insert(code).inserted else { continue }
            if code == 0x2a || code == 0x4c { capture?(""); continue }
            let flags = key.modifierFlags
            let name = (0x3a...0x45).contains(code) ? "f\(code - 0x3a + 1)" : (0x68...0x73).contains(code) ? "f\(code - 0x68 + 13)" : ProjectScriptShortcut.keyName(key.charactersIgnoringModifiers)
            if let value = ProjectScriptShortcut.captured(key: name, command: flags.contains(.command), control: flags.contains(.control), shift: flags.contains(.shift), option: flags.contains(.alternate)) { capture?(value) }
        }
        if !forwarded.isEmpty { super.pressesBegan(forwarded, with: event) }
    }
    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) { for press in presses { if let key = press.key { held.remove(key.keyCode.rawValue) } }; super.pressesEnded(presses, with: event) }
    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) { held.removeAll(); super.pressesCancelled(presses, with: event) }
    override func resignFirstResponder() -> Bool { held.removeAll(); return super.resignFirstResponder() }
}
#endif
