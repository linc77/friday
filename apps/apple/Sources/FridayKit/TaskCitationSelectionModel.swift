import SwiftUI
#if os(macOS)
import AppKit
typealias TaskCitationPlatformView = NSView
#else
import UIKit
typealias TaskCitationPlatformView = UIView
#endif

struct TaskCitationSourceIdentity: Equatable {
    let environment: String; let task: String; let message: String; let connection: String
}
enum TaskCitationTextBoundary {
    static func word(in text:String,at offset:Int) -> NSRange {
        let source=text as NSString;guard source.length>0 else { return NSRange(location:0,length:0) }
        let point=min(max(0,offset),source.length-1);var result=source.rangeOfComposedCharacterSequence(at:point)
        source.enumerateSubstrings(in:NSRange(location:0,length:source.length),options:[.byWords,.substringNotRequired]) { _,range,_,stop in
            if NSLocationInRange(point,range) { result=range;stop.pointee=true }
        };return result
    }
}
@MainActor protocol TaskCitationNativePart: AnyObject {
    var citationKey: [Int] { get }
    var citationGroup: [Int] { get }
    var citationText: String { get }
    var citationView: TaskCitationPlatformView { get }
    func offset(at point: CGPoint) -> Int
    func rectangles(_ range: NSRange) -> [CGRect]
    func highlight(_ range: NSRange?)
    func link(at offset: Int) -> URL?
    func reveal(_ range: NSRange)
    func linkRectangles() -> [CGRect]
}
extension TaskCitationNativePart { func linkRectangles() -> [CGRect] { [] } }
private final class CitationWeakPart { weak var value: (any TaskCitationNativePart)?; init(_ value: any TaskCitationNativePart) { self.value=value } }

@MainActor final class TaskCitationSelectionModel: ObservableObject {
    struct Entry { let part: any TaskCitationNativePart; let range: NSRange }
    let source: TaskCitationSourceIdentity
    @Published private(set) var selected: NSRange?
    @Published private(set) var actionPoint = CGPoint.zero
    @Published private(set) var actionVisible = false
    @Published private(set) var revision = 0
    var canCite = false
    var cite: (() -> Void)?
    var focusAction: (() -> Void)?
    var didSelect: (() -> Void)?
    private var parts: [String:CitationWeakPart] = [:]
    private var scheduled = false
    private(set) var text = ""
    private(set) var entries: [Entry] = []
    private var settle: Task<Void,Never>?
    private(set) var revealing=false
    private var revealGeneration=UUID()
    init(source:TaskCitationSourceIdentity) { self.source=source }
    func register(_ part:any TaskCitationNativePart) {
        let key=part.citationKey.map(String.init).joined(separator:":")
        parts[key]=CitationWeakPart(part); schedule()
    }
    func unregister(_ part:any TaskCitationNativePart) {
        let key=part.citationKey.map(String.init).joined(separator:":")
        if parts[key]?.value === part { parts.removeValue(forKey:key);schedule() }
    }
    private func schedule() {
        guard !scheduled else{return};scheduled=true
        Task { @MainActor [weak self] in await Task.yield();guard let self else{return};self.scheduled=false;self.rebuild() }
    }
    func rebuild() {
        let previous=selected.flatMap { TaskAssistantCitation.make(environment:source.environment,task:source.task,message:source.message,source:text,range:$0) }
        let values=parts.values.compactMap(\.value).sorted { $0.citationKey.lexicographicallyPrecedes($1.citationKey) }
        var text="",entries:[Entry]=[],group:[Int]?,offset=0
        for part in values where !part.citationText.isEmpty {
            if let group,group != part.citationGroup {text+="\n";offset+=1}
            let length=part.citationText.utf16.count
            entries.append(Entry(part:part,range:NSRange(location:offset,length:length)))
            text+=part.citationText;offset+=length;group=part.citationGroup
        }
        let changed = !self.text.utf16.elementsEqual(text.utf16)
        self.entries=entries;self.text=text
        if changed {
            revision += 1
            if let previous {select(previous.rawRange(in:text),showAction:actionVisible)}
        } else { repaint() }
    }
    func select(_ range:NSRange?,showAction:Bool=false) {
        settle?.cancel()
        let bounded=range.map {TaskSourceEditorPosition.selection($0,length:text.utf16.count)}
        selected=bounded?.length == 0 ? nil : bounded;actionVisible=showAction && selected != nil
        repaint();didSelect?()
    }
    func finish(at point:CGPoint,clicks:Int=1) {
        actionPoint=point;settle?.cancel()
        settle=Task { @MainActor [weak self] in
            if clicks>=2 {try? await Task.sleep(for:.milliseconds(500))}
            guard !Task.isCancelled,let self else{return};self.actionVisible=self.selected != nil
        }
    }
    func dismiss() {settle?.cancel();select(nil);actionVisible=false}
    var citation:TaskAssistantCitation? {selected.flatMap {TaskAssistantCitation.make(environment:source.environment,task:source.task,message:source.message,source:text,range:$0)}}
    func quote() {guard canCite,citation?.valid == true else{return};actionVisible=false;cite?()}
    func repaint() {
        for entry in entries {
            let overlap=selected.map {NSIntersectionRange($0,entry.range)}
            entry.part.highlight(overlap.flatMap {$0.length > 0 ? NSRange(location:$0.location-entry.range.location,length:$0.length) : nil})
        }
    }
    func hit(_ point:CGPoint,in root:TaskCitationPlatformView) -> Int? {
        for entry in entries {
            let view=entry.part.citationView,local=view.convert(point,from:root)
            #if os(macOS)
            let visible=view.window != nil && !view.isHidden
            #else
            let visible=view.window != nil && !view.isHidden && view.alpha>0
            #endif
            #if os(macOS)
            let unclipped=view.visibleRect.contains(local)
            #else
            var unclipped=true,parent:UIView?=view
            while let current=parent {
                if current.isHidden || current.alpha<=0 || current.clipsToBounds && !current.bounds.contains(current.convert(point,from:root)) { unclipped=false;break };parent=current.superview
            }
            #endif
            if visible,unclipped,view.bounds.contains(local) {return entry.range.location+min(entry.range.length,max(0,entry.part.offset(at:local)))}
        };return nil
    }
    func closest(_ point:CGPoint,in root:TaskCitationPlatformView) -> Int {
        if let value=hit(point,in:root){return value}
        var best:(CGFloat,Int)?
        for entry in entries {
            let view=entry.part.citationView,rect=view.convert(view.bounds,to:root)
            let clamped=CGPoint(x:min(max(point.x,rect.minX),rect.maxX),y:min(max(point.y,rect.minY),rect.maxY))
            let distance=abs(clamped.x-point.x)+abs(clamped.y-point.y)
            let offset=entry.range.location+min(entry.range.length,max(0,entry.part.offset(at:view.convert(clamped,from:root))))
            if best == nil || distance<best!.0 {best=(distance,offset)}
        };return best?.1 ?? 0
    }
    func rectangles(_ range:NSRange,in root:TaskCitationPlatformView) -> [CGRect] {
        entries.flatMap {entry->[CGRect] in
            let overlap=NSIntersectionRange(range,entry.range);guard overlap.length>0 else{return[]}
            return entry.part.rectangles(NSRange(location:overlap.location-entry.range.location,length:overlap.length)).map {entry.part.citationView.convert($0,to:root)}
        }
    }
    func link(_ offset:Int) -> URL? {
        guard let entry=entries.first(where:{NSLocationInRange(offset,$0.range)})else{return nil}
        return entry.part.link(at:offset-entry.range.location)
    }
    func reveal(_ citation:TaskAssistantCitation) -> Bool {
        guard source.environment==citation.environmentId,source.task==citation.threadId,source.message==citation.messageId,let range=citation.rawRange(in:text)else{return false}
        let generation=UUID();revealGeneration=generation;revealing=true
        select(range)
        if let entry=entries.first(where:{NSIntersectionRange($0.range,range).length>0}) {
            let overlap=NSIntersectionRange(entry.range,range);entry.part.reveal(NSRange(location:overlap.location-entry.range.location,length:overlap.length))
        }
        Task { @MainActor [weak self] in try? await Task.sleep(for:.milliseconds(350));if self?.revealGeneration==generation { self?.revealing=false } }
        return true
    }
}

private struct CitationDocumentKey:EnvironmentKey {static let defaultValue:TaskCitationSelectionModel?=nil}
private struct CitationPathKey:EnvironmentKey {static let defaultValue:[Int]=[]}
private struct CitationSecondaryKey:EnvironmentKey {static let defaultValue=false}
extension EnvironmentValues {
    var taskCitationDocument:TaskCitationSelectionModel? {get{self[CitationDocumentKey.self]}set{self[CitationDocumentKey.self]=newValue}}
    var taskCitationPath:[Int] {get{self[CitationPathKey.self]}set{self[CitationPathKey.self]=newValue}}
    var taskCitationSecondary:Bool {get{self[CitationSecondaryKey.self]}set{self[CitationSecondaryKey.self]=newValue}}
}
