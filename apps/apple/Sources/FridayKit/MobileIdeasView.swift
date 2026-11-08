#if os(iOS)
import SwiftUI
import UIKit

private enum MobileIdeasLayout: String, CaseIterable, Identifiable {
    case list, journal
    var id: String { rawValue }
    var title: String { self == .list ? "备忘录列表" : "手记卡片" }
    var symbol: String { self == .list ? "list.bullet" : "rectangle.grid.1x2" }
}

struct MobileIdeasView: View {
    @Bindable var store: FridayStore
    let ideas: [Idea]
    @Binding var search: String
    let hasDraft: Bool
    let transitionNamespace: Namespace.ID
    let open: (Idea) -> Void
    let create: () -> Void
    let delete: (Idea) -> Void
    @FridayPreference("friday.mobileIdeasLayout") private var layout: MobileIdeasLayout = .list
    @Environment(\.locale) private var locale
    @FocusState private var searching: Bool

    private struct NoteSection: Identifiable {
        let id: String
        let title: String
        var notes: [Idea]
    }

    // Use the same modification date for sorting, grouping and row timestamps.
    // Invalid dates remain visible in the final section instead of disappearing.
    private var sections: [NoteSection] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today) ?? today
        let week = calendar.date(byAdding: .day, value: -7, to: today) ?? today
        let month = calendar.date(byAdding: .day, value: -30, to: today) ?? today
        var result: [NoteSection] = []
        let dated = ideas.map { (note: $0, date: modificationDate($0)) }
            .sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
        for item in dated {
            let key: String
            let title: String
            if let date = item.date {
                if layout == .journal {
                    let components = calendar.dateComponents([.era, .year, .month], from: date)
                    key = "\(components.era ?? 0)-\(components.year ?? 0)-\(components.month ?? 0)"
                    title = date.formatted(Date.FormatStyle().year().month(.wide).locale(locale))
                } else if date >= today { key = "today"; title = "今天" }
                else if date >= yesterday { key = "yesterday"; title = "昨天" }
                else if date >= week { key = "week"; title = "过去 7 天" }
                else if date >= month { key = "month"; title = "过去 30 天" }
                else { key = "older"; title = "更早" }
            } else { key = "unknown"; title = "日期未知" }
            if let index = result.indices.last, result[index].id == key {
                result[index].notes.append(item.note)
            } else {
                result.append(NoteSection(id: key, title: title, notes: [item.note]))
            }
        }
        return result
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                ForEach(sections) { section in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(fridayString: section.title)
                            .font(.title3.bold())
                            .accessibilityAddTraits(.isHeader)
                        if layout == .list {
                            VStack(spacing: 0) {
                                ForEach(section.notes) { idea in
                                    noteButton(idea) { listRow(idea) }
                                        .modifier(MobileIdeaZoomSource(id: idea.id, namespace: transitionNamespace, cornerRadius: 16))
                                    if idea.id != section.notes.last?.id {
                                        Divider().padding(.horizontal, 24)
                                    }
                                }
                            }
                            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24))
                        } else {
                            ForEach(section.notes) { idea in
                                journalCard(idea)
                                    .modifier(MobileIdeaZoomSource(id: idea.id, namespace: transitionNamespace, cornerRadius: 20))
                            }
                        }
                    }
                }
                if ideas.isEmpty {
                    EmptyPanel(icon: search.isEmpty ? "scribble" : "magnifyingglass",
                               title: search.isEmpty ? "为下一个念头留个位置" : "没有找到笔记",
                               subtitle: search.isEmpty ? "记下今天，保存图片和链接，慢慢积累自己的资料。" : "试试标题或正文中的其他词。")
                        .padding(.top, 32)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 20)
        }
        .scrollDismissesKeyboard(.interactively)
        .fridayMobileHomeScroll()
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker(selection: $layout) {
                        ForEach(MobileIdeasLayout.allCases) { option in
                            FridaySymbolLabel(friday: option.title, systemImage: option.symbol).tag(option)
                        }
                    } label: { Text(friday: "布局方式") }
                    Button(friday: hasDraft ? "继续草稿" : "新建笔记", systemImage: "square.and.pencil", action: create)
                } label: {
                    FridaySymbolImage(systemName: "ellipsis")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(FridaySymbolButtonStyle())
                .accessibilityLabel(Text(friday: "布局与更多操作"))
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        .fridayMobileHomeNavigation(inComposer: true)
    }

    private var bottomBar: some View {
        FridayMobileComposerDock(homeSection: .inbox) {
            HStack(spacing: 8) {
                FridaySymbolImage(systemName: "magnifyingglass").accessibilityHidden(true)
                    .padding(.leading, 16)
                TextField(friday: "搜索笔记", text: $search)
                    .font(.body)
                    .textFieldStyle(.plain)
                    .focused($searching)
                    .submitLabel(.search)
                    .onSubmit { searching = false }
                if !search.isEmpty {
                    Button { search = "" } label: {
                        FridaySymbolImage(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(FridaySymbolButtonStyle())
                    .accessibilityLabel(Text(friday: "清除搜索"))
                }
                Button { searching = false; create() } label: {
                    FridaySymbolImage(systemName: "square.and.pencil")
                        .font(.system(size: 22, weight: .regular))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(FridaySymbolButtonStyle())
                .accessibilityLabel(Text(fridayString: hasDraft ? "继续草稿" : "新建笔记"))
                .modifier(MobileIdeaZoomSource(id: "new-note", namespace: transitionNamespace, cornerRadius: 24))
            }
            .modifier(FridayMobileInputSurface(focused: searching))
        }
    }

    private func noteButton<Content: View>(_ idea: Idea, @ViewBuilder content: () -> Content) -> some View {
        Button { searching = false; open(idea) } label: { content().contentShape(Rectangle()) }
            .buttonStyle(FridaySymbolButtonStyle())
            .accessibilityHint(Text(friday: "打开笔记，阅读或编辑内容"))
            .contextMenu {
                Button(friday: "打开笔记") { open(idea) }
                Button(friday: "删除笔记", role: .destructive) { delete(idea) }
            }
    }

    private func listRow(_ idea: Idea) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(idea.displayTitle).font(.body.weight(.semibold)).lineLimit(1)
                HStack(spacing: 8) {
                    timestamp(idea, detailed: false).fixedSize()
                    preview(idea).lineLimit(1)
                }
                .font(.subheadline).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let image = idea.images?.first {
                IdeaImageView(store: store, image: image, thumbnail: true, thumbnailHeight: 40)
                    .frame(width: 40, height: 40).clipped().allowsHitTesting(false)
            }
        }
        .padding(.horizontal, 24).padding(.vertical, 12)
    }

    private func journalCard(_ idea: Idea) -> some View {
        VStack(spacing: 0) {
            noteButton(idea) {
                VStack(alignment: .leading, spacing: 0) {
                    if let images = idea.images, !images.isEmpty {
                        MobileIdeaCollage(store: store, images: images, text: journalText(idea)).padding(4)
                    }
                    if !journalText(idea).isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            if let title = idea.title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Text(title).font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                            }
                            if !idea.preview.isEmpty {
                                Text(idea.preview).font(.body).lineSpacing(4).lineLimit(12)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                    }
                }
            }
            Divider().padding(.horizontal, 12)
            HStack {
                timestamp(idea, detailed: true).font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Menu {
                    Button(friday: "打开笔记") { open(idea) }
                    Button(friday: "删除笔记", role: .destructive) { delete(idea) }
                } label: {
                    FridaySymbolImage(systemName: "ellipsis").frame(width: 44, height: 44)
                }
                .buttonStyle(FridaySymbolButtonStyle())
                .accessibilityLabel(Text(friday: "笔记操作"))
            }.padding(.leading, 16).padding(.trailing, 4)
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }

    private func journalText(_ idea: Idea) -> String {
        [idea.title ?? "", idea.preview]
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .joined(separator: "\n")
    }

    private func preview(_ idea: Idea) -> Text {
        var lines = idea.preview.components(separatedBy: .newlines).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        if lines.first == idea.displayTitle { lines.removeFirst() }
        return lines.isEmpty ? Text(friday: "无更多文本") : Text(lines.joined(separator: layout == .list ? " " : "\n"))
    }

    private func timestamp(_ idea: Idea, detailed: Bool) -> Text {
        if store.outbox.contains(where: { $0.id == idea.id }) { return Text(friday: "待同步") }
        guard let date = modificationDate(idea) else { return Text("—") }
        if detailed {
            return Text(date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale)))
        }
        if Calendar.current.isDateInToday(date) {
            return Text(date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale)))
        }
        if Calendar.current.isDateInYesterday(date) { return Text(friday: "昨天") }
        return Text(date.formatted(Date.FormatStyle(date: .numeric, time: .omitted).locale(locale)))
    }

    private func modificationDate(_ idea: Idea) -> Date? {
        let value = idea.updatedAt ?? idea.createdAt
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

/// Match the complete card, including its footer, to the native interactive zoom.
/// Keep the source in the navigation stack so a completed or cancelled return
/// does not reconstruct the list or reset its scroll position.
private struct MobileIdeaZoomSource: ViewModifier {
    let id: String
    let namespace: Namespace.ID
    let cornerRadius: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18.0, *), !reduceMotion {
            content.matchedTransitionSource(id: id, in: namespace) { source in
                source.clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            }
        } else {
            content
        }
    }
}

struct MobileIdeaZoomDestination: ViewModifier {
    let id: String
    let namespace: Namespace.ID
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18.0, *), !reduceMotion {
            content.navigationTransition(.zoom(sourceID: id, in: namespace))
        } else {
            content
        }
    }
}

private struct MobileIdeaCollage: View {
    @Bindable var store: FridayStore
    let images: [IdeaImage]
    let text: String
    @State private var availableWidth: CGFloat = 320
    @State private var imageSizes: [String: CGSize] = [:]
    @ScaledMetric(relativeTo: .body) private var bodyFontSize: CGFloat = 17

    private var plan: MobileIdeaCollagePlan {
        let font = UIFont.systemFont(ofSize: bodyFontSize)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 4
        let textHeight = (text as NSString).boundingRect(
            with: CGSize(width: max(1, availableWidth - 24), height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font, .paragraphStyle: paragraph], context: nil
        ).height
        // Leave room for the writing: a longer excerpt uses the compact five-photo
        // mosaic, while short entries can show a second row (up to nine photos).
        let limit = textHeight > (font.lineHeight + 4) * 4 ? 5 : 9
        let ratios = images.prefix(limit).map { image -> CGFloat in
            guard let size = imageSizes[image.id], size.width > 0, size.height > 0 else { return 1 }
            return size.width / size.height
        }
        return MobileIdeaCollagePlan(width: availableWidth, ratios: ratios)
    }

    var body: some View {
        let arrangement = plan
        GeometryReader { geometry in
            ForEach(Array(images.prefix(arrangement.frames.count).enumerated()), id: \.element.id) { index, image in
                let frame = arrangement.frames[index]
                IdeaImageView(store: store, image: image, thumbnail: true, thumbnailHeight: frame.height,
                              onImageSize: { size in
                                  if imageSizes[image.id] != size { imageSizes[image.id] = size }
                              })
                    .frame(width: frame.width, height: frame.height)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(alignment: .bottomTrailing) {
                        if index == arrangement.frames.count - 1, images.count > arrangement.frames.count {
                            Text("+\(images.count - arrangement.frames.count)")
                                .font(.callout.weight(.semibold))
                                .padding(6).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                                .padding(4)
                        }
                    }
                    .position(x: frame.midX, y: frame.midY)
            }
            .onAppear { availableWidth = max(1, geometry.size.width) }
            .onChange(of: geometry.size.width) { _, width in availableWidth = max(1, width) }
        }
        .frame(height: arrangement.height)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Size only the media area; the surrounding card keeps its natural text height.
/// Small collections follow their aspect ratios. Larger collections use the
/// journal's dominant first photo with smaller tiles, adding a row as needed.
private struct MobileIdeaCollagePlan {
    var frames: [CGRect] = []
    var height: CGFloat = 0

    init(width: CGFloat, ratios: [CGFloat]) {
        guard width > 0, !ratios.isEmpty else { return }
        let gap: CGFloat = 4
        let count = ratios.count
        if count == 1 {
            // Preserve the complete single photo, including a tall screenshot.
            // Very tall images get narrower instead of being cropped to a square.
            height = min(width / ratios[0], width * 1.25)
            let imageWidth = min(width, height * ratios[0])
            frames = [CGRect(x: (width - imageWidth) / 2, y: 0, width: imageWidth, height: height)]
        } else if count == 2 {
            if ratios.allSatisfy({ $0 > 1.45 }) {
                // Two wide photos read better as full-width rows.
                for ratio in ratios {
                    let rowHeight = width / ratio
                    frames.append(CGRect(x: 0, y: height, width: width, height: rowHeight))
                    height += rowHeight + gap
                }
                height -= gap
            } else {
                let rowHeight = min((width - gap) / ratios.reduce(0, +), width * 1.25)
                let totalWidth = rowHeight * ratios.reduce(0, +) + gap
                var x = (width - totalWidth) / 2
                for ratio in ratios {
                    let tileWidth = rowHeight * ratio
                    frames.append(CGRect(x: x, y: 0, width: tileWidth, height: rowHeight))
                    x += tileWidth + gap
                }
                height = rowHeight
            }
        } else if count <= 4 {
            if ratios[0] > 1.45 {
                let leadHeight = width / ratios[0]
                frames.append(CGRect(x: 0, y: 0, width: width, height: leadHeight))
                let remaining = Array(ratios.dropFirst())
                let rowHeight = min((width - gap * CGFloat(remaining.count - 1)) / remaining.reduce(0, +), width * 0.6)
                let rowWidth = rowHeight * remaining.reduce(0, +) + gap * CGFloat(remaining.count - 1)
                var x = (width - rowWidth) / 2
                for ratio in remaining {
                    frames.append(CGRect(x: x, y: leadHeight + gap, width: rowHeight * ratio, height: rowHeight))
                    x += rowHeight * ratio + gap
                }
                height = leadHeight + gap + rowHeight
            } else {
                let sideCount = count - 1
                // Solve for equal-height columns using the photos' actual ratios.
                let inverseSum = ratios.dropFirst().reduce(CGFloat(0)) { $0 + 1 / $1 }
                let naturalLeadWidth = (inverseSum * (width - gap) + gap * CGFloat(sideCount - 1)) / (1 / ratios[0] + inverseSum)
                let leadWidth = min(width * 0.68, max(width * 0.4, naturalLeadWidth))
                let sideWidth = width - leadWidth - gap
                height = min(width * 0.95, max(width * 0.5, leadWidth / ratios[0]))
                frames.append(CGRect(x: 0, y: 0, width: leadWidth, height: height))
                let usableHeight = height - gap * CGFloat(sideCount - 1)
                var y: CGFloat = 0
                for ratio in ratios.dropFirst() {
                    let tileHeight = usableHeight * (1 / ratio) / inverseSum
                    frames.append(CGRect(x: leadWidth + gap, y: y, width: sideWidth, height: tileHeight))
                    y += tileHeight + gap
                }
            }
        } else {
            let leadWidth = (width - gap) / 2
            let tileWidth = (leadWidth - gap) / 2
            // Keep the recognizable one-large/four-small arrangement, while
            // allowing a landscape lead to reduce the first row's height.
            let firstHeight = min(width * 0.65, max(width * 0.36, leadWidth / ratios[0]))
            let tileHeight = (firstHeight - gap) / 2
            frames.append(CGRect(x: 0, y: 0, width: leadWidth, height: firstHeight))
            for index in 0..<4 {
                frames.append(CGRect(x: leadWidth + gap + CGFloat(index % 2) * (tileWidth + gap),
                                     y: CGFloat(index / 2) * (tileHeight + gap), width: tileWidth, height: tileHeight))
            }
            height = firstHeight
            if count > 5 {
                let remaining = Array(ratios.dropFirst(5))
                // Extra photos fill a complete row; six, seven and eight images
                // never leave empty slots in a hard-coded four-column grid.
                let weights = remaining.map { min(1.6, max(0.65, $0)) }
                let rowHeight = min(width * 0.42, (width - gap * CGFloat(remaining.count - 1)) / weights.reduce(0, +))
                let usableWidth = width - gap * CGFloat(remaining.count - 1)
                var x: CGFloat = 0
                for weight in weights {
                    let tileWidth = usableWidth * weight / weights.reduce(0, +)
                    frames.append(CGRect(x: x, y: height + gap, width: tileWidth, height: rowHeight))
                    x += tileWidth + gap
                }
                height += gap + rowHeight
            }
        }
    }
}
#endif
