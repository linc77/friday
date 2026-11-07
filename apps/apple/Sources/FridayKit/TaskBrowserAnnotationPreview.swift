import SwiftUI

struct TaskBrowserAnnotationPreview:View {
    @ObservedObject var store:FridayStore
    let annotation:TaskBrowserAnnotationRecord
    @Environment(\.taskBrowserOpen) private var openPage
    var body:some View {
        ScrollView {
            VStack(alignment:.leading,spacing:12) {
                HStack(alignment:.top) {
                    VStack(alignment:.leading,spacing:4) {if let title=annotation.pageTitle,!title.isEmpty {Text(verbatim:title).font(.callout.weight(.medium))};Text(verbatim:annotation.pageUrl).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)}
                    Spacer(minLength:0)
                    if let url=TaskBrowserPolicy.url(annotation.pageUrl),let openPage {Button {_=openPage(url)} label:{FridaySymbolImage(systemName:"arrow.up.right")}.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday:"打开批注网页"))}
                }
                if !annotation.comment.isEmpty {Text(verbatim:annotation.comment).font(.body).textSelection(.enabled)}
                if let id=annotation.screenshotImageId {IdeaImageView(store:store,image:IdeaImage(id:id,name:"preview-annotation.png",mediaType:"image/png"),maximumHeight:180)}
                Text(verbatim:annotation.summary).font(.caption).foregroundStyle(.secondary)
                if !annotation.styleChangeDetails.isEmpty {
                    VStack(alignment:.leading,spacing:4) {Text(friday:"请求的样式修改").font(.caption.weight(.medium));ForEach(Array(annotation.styleChangeDetails.enumerated()),id:\.offset) {_,change in Text(verbatim:"\(change.property): \(change.previousValue.isEmpty ? "(unset)":change.previousValue) → \(change.value)").font(.system(.caption,design:.monospaced)).textSelection(.enabled)}}
                }
                ForEach(Array(annotation.elements.enumerated()),id:\.offset) {index,element in
                    Divider()
                    VStack(alignment:.leading,spacing:6) {
                        Text(verbatim:"\(index+1). <\(element.tagName)>"+(element.componentName.map {" · "+$0} ?? "")).font(.callout.weight(.medium))
                        if let selector=element.selector {Text(verbatim:selector).font(.system(.caption,design:.monospaced)).textSelection(.enabled)}
                        if let source=element.source,let file=source.fileName {Text(verbatim:file+(source.lineNumber.map {":"+String($0)} ?? "")).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)}
                        Text(verbatim:element.htmlPreview).font(.system(.caption,design:.monospaced)).textSelection(.enabled)
                        if !element.styles.isEmpty {Text(verbatim:element.styles).font(.system(.caption2,design:.monospaced)).foregroundStyle(.secondary).textSelection(.enabled)}
                    }
                }
            }.frame(maxWidth:.infinity,alignment:.leading)
        }
    }
}
