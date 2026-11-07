import Foundation

/// Keep large JSON frames off the UI executor. Each connection owns its
/// parser so event names and payloads stay ordered across suspension points.
actor TaskStreamDecoding {
    private var workspace = TaskWorkspaceStream()
    private var detail = TaskDetailStream()

    func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
        try JSONDecoder().decode(type, from: data)
    }

    func readWorkspace(_ line: String) throws -> TaskWorkspaceUpdate? {
        try workspace.read(line)
    }

    func readDetail(_ line: String) throws -> TaskDetailUpdate? {
        try detail.read(line)
    }
}
