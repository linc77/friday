#if os(iOS)
import UIKit

final class TaskBrowserMobileHost:UIView {
    weak var controller:TaskBrowserController?
    let floating:Bool
    init(controller:TaskBrowserController,floating:Bool) {self.controller=controller;self.floating=floating;super.init(frame:.zero)}
    required init?(coder:NSCoder) {fatalError("init(coder:) has not been implemented")}
    func attach() {
        guard let controller,!controller.closed,controller.floatingInTask==floating else{return}
        if controller.view.superview !== self {controller.view.removeFromSuperview();addSubview(controller.view)}
        controller.view.frame=bounds;controller.view.autoresizingMask=[.flexibleWidth,.flexibleHeight]
    }
    override func layoutSubviews() {super.layoutSubviews();if let controller,controller.view.superview === self {controller.view.frame=bounds}}
}
#endif
