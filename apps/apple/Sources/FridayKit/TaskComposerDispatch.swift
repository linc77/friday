import Foundation

enum TaskComposerDispatch: String {
    case auto, steer, queue

    static func resolve(running: Bool, canSteer: Bool, preference: String, alternate: Bool) -> Self {
        guard running else { return .auto }
        guard canSteer else { return .queue }
        let normal: Self = preference == "steer" ? .steer : .queue
        return alternate ? (normal == .queue ? .steer : .queue) : normal
    }
}
