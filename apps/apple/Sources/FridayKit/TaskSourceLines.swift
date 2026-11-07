import Foundation

struct TaskSourceLines {
    let starts: [Int]; let length: Int
    init(_ source: String) {
        let text = source as NSString; length = text.length; var starts = [0], offset = 0
        while offset < text.length {
            var end = 0, contentsEnd = 0; text.getLineStart(nil, end: &end, contentsEnd: &contentsEnd, for: NSRange(location: offset, length: 0))
            guard end > offset else { break }; if contentsEnd < end { starts.append(end) }; offset = end
        }
        self.starts = starts
    }
    func number(at offset: Int) -> Int {
        var low = 0, high = starts.count
        while low < high { let middle = (low + high) / 2; if starts[middle] <= offset { low = middle + 1 } else { high = middle } }
        return max(1, low)
    }
    func range(line: Int) -> NSRange {
        let index = min(max(0, line - 1), starts.count - 1), start = starts[index]
        return NSRange(location: start, length: max(0, (index + 1 < starts.count ? starts[index + 1] : length) - start))
    }
}
