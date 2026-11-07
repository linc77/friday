import SwiftUI

struct TaskChangeRequestMarkdown: View {
    let text: String
    var compact = false
    @State private var images: [MarkdownImage] = []
    @State private var prepared: [TaskChangeRequestMarkdownSegment] = []
    @State private var preparedSource: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(preparedSource == text ? prepared : [.init(id: "markdown:0", content: .markdown(text))]) { segment in
                switch segment.content {
                case .markdown(let source): AgentMarkdown(text: source, compact: compact, galleryImages: images)
                case .image(let url): AgentMarkdown(text: "![](<\(url)>)", compact: compact, galleryImages: images)
                case .video(let url): MarkdownVideoView(image: MarkdownImage(source: url, alt: "", title: nil, link: nil), workspacePath: nil)
                }
            }
        }.onPreferenceChange(MarkdownVisibleImages.self) { images = $0 }
        .task(id: text) {
            let source = text
            let task = Task.detached(priority: .userInitiated) { TaskChangeRequestMarkdownSegments.split(source) }
            let segments = await withTaskCancellationHandler(operation: { await task.value }, onCancel: { task.cancel() })
            guard !Task.isCancelled else { return }; prepared = segments; preparedSource = source
        }
    }
}
