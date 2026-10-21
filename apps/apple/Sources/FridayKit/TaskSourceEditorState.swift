import Foundation

struct TaskSourceUndoSnapshot: Equatable {
    let source: String
    let ranges: [NSRange]
    static func replacement(_ source: String) -> Self { Self(source: source, ranges: [NSRange(location: (source as NSString).length, length: 0)]) }
}

struct TaskSourceRevealRequest: Equatable {
    let line: Int?; let generation: Int
    func needsReveal(after previous: Self?) -> Bool { line != nil && self != previous }
}

enum TaskSourceEditorPosition {
    static func selection(_ range: NSRange, length: Int) -> NSRange {
        let size = max(0, length), start = range.location == NSNotFound ? 0 : min(size, max(0, range.location))
        return NSRange(location: start, length: min(max(0, range.length), size - start))
    }
    static func origin(_ point: CGPoint, content: CGSize, viewport: CGSize) -> CGPoint {
        CGPoint(x: min(max(0, point.x), max(0, content.width - viewport.width)), y: min(max(0, point.y), max(0, content.height - viewport.height)))
    }
}
