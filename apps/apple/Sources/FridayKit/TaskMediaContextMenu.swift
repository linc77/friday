import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor final class TaskMediaContextMenu: NSObject {
    #if os(macOS)
    private final class Target: NSObject {
        let action: () -> Void
        init(_ action: @escaping () -> Void) { self.action = action }
        @objc func invoke(_ sender: Any?) { action() }
    }
    func show(at point: CGPoint, in view: NSView, source: TaskMediaActionSource, controller: TaskMediaExportController) {
        let menu = NSMenu(); menu.autoenablesItems = false
        for action in source.actions {
            let target = Target { [weak view] in controller.perform(action, source: source, window: view?.window) }
            let item = NSMenuItem(title: action.localizedLabel(kind: source.kind), action: #selector(Target.invoke(_:)), keyEquivalent: "")
            item.target = target; item.representedObject = target
            item.image = NSImage(systemSymbolName: action.symbol, accessibilityDescription: nil)
            item.isEnabled = ![TaskMediaAction.save, .copyImage].contains(action) || source.prepare != nil && !controller.busy
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: CGPoint(x: point.x, y: view.isFlipped ? point.y : view.bounds.height - point.y), in: view)
    }
    #else
    private var interaction: UIEditMenuInteraction?
    private var source: TaskMediaActionSource?
    private weak var view: UIView?
    private var controller: TaskMediaExportController?
    func show(at point: CGPoint, in view: UIView, source: TaskMediaActionSource, controller: TaskMediaExportController) {
        if self.view !== view { detach(); let interaction = UIEditMenuInteraction(delegate: self); view.addInteraction(interaction); self.interaction = interaction; self.view = view }
        self.source = source; self.controller = controller
        interaction?.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
    }
    func detach() { if let interaction { interaction.dismissMenu(); view?.removeInteraction(interaction) }; interaction = nil; source = nil; controller = nil; view = nil }
    #endif
}
#if !os(macOS)
extension TaskMediaContextMenu: UIEditMenuInteractionDelegate {
    func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
        guard let source, let controller else { return nil }
        return UIMenu(children: source.actions.map { action in
            UIAction(title: action.localizedLabel(kind: source.kind), image: UIImage(systemName: action.symbol), attributes: [TaskMediaAction.save, .copyImage].contains(action) && (source.prepare == nil || controller.busy) ? .disabled : []) { [weak view] _ in controller.perform(action, source: source, window: view?.window) }
        })
    }
}
#endif
