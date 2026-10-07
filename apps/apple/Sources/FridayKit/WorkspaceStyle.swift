import Foundation

enum WorkspaceStyle {
    static let icons = ["folder", "terminal", "curlybraces", "app", "globe", "book.closed", "lightbulb", "paintbrush", "hammer", "star", "heart", "briefcase"]
    static let colors = ["gray", "blue", "teal", "green", "yellow", "orange", "pink", "purple"]
    static let iconLabels = ["文件夹", "终端", "代码", "应用", "网页", "书籍", "灵感", "画笔", "工具", "星标", "爱心", "工作"]
    static let colorLabels = ["灰色", "蓝色", "青色", "绿色", "黄色", "橙色", "粉色", "紫色"]

    static func icon(_ value: String?) -> String {
        value.flatMap { icons.contains($0) ? $0 : nil } ?? "folder"
    }

    static func color(_ value: String?, name: String) -> String {
        if let value, colors.contains(value) { return value }
        // Preserve the sidebar's existing colors until the user saves a choice.
        let legacy = ["teal", "blue", "orange", "purple", "pink"]
        return legacy[name.utf8.reduce(0) { ($0 + Int($1)) % legacy.count }]
    }

    static func validName(_ name: String) -> Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.utf16.count <= 120
    }
}
