import SwiftUI
#if os(macOS)
import AppKit
private typealias CitationFont=NSFont
private typealias CitationColor=NSColor
#else
import UIKit
private typealias CitationFont=UIFont
private typealias CitationColor=UIColor
#endif

enum TaskCitationTextRole:Equatable {case body,callout,heading(Int),code}
@MainActor enum TaskCitationTextStyle {
    private static func font(_ role:TaskCitationTextRole)->CitationFont {
        switch role {
        case .body:return .preferredFont(forTextStyle:.body)
        case .callout:return .preferredFont(forTextStyle:.callout)
        case .code:return .monospacedSystemFont(ofSize:CitationFont.preferredFont(forTextStyle:.callout).pointSize,weight:.regular)
        case .heading(let level):
            let base=CitationFont.preferredFont(forTextStyle:level==1 ? .title2 : level==2 ? .title3 : .headline)
            return .systemFont(ofSize:base.pointSize,weight:.semibold)
        }
    }
    static func runs(_ runs:[MarkdownRun],role:TaskCitationTextRole,links:[URL?],secondary:Bool)->NSAttributedString {
        let paragraph=NSMutableParagraphStyle();paragraph.lineSpacing=role == .code ? 4 : 6
        #if os(macOS)
        let color=secondary ? NSColor.secondaryLabelColor : .labelColor
        #else
        let color=secondary ? UIColor.secondaryLabel : .label
        #endif
        let result=NSMutableAttributedString()
        for (index,run) in runs.enumerated() {
            var font=font(role)
            if run.style.contains(.code)||run.style.contains(.keyboard) {font=CitationFont.monospacedSystemFont(ofSize:font.pointSize,weight:.regular)}
            if run.style.contains(.superscriptText)||run.style.contains(.subscriptText) {font = .preferredFont(forTextStyle:.caption1)}
            #if os(macOS)
            if run.style.contains(.strong){font=NSFontManager.shared.convert(font,toHaveTrait:.boldFontMask)}
            if run.style.contains(.emphasis){font=NSFontManager.shared.convert(font,toHaveTrait:.italicFontMask)}
            #else
            var traits=font.fontDescriptor.symbolicTraits
            if run.style.contains(.strong){traits.insert(.traitBold)}
            if run.style.contains(.emphasis){traits.insert(.traitItalic)}
            if let descriptor=font.fontDescriptor.withSymbolicTraits(traits){font=UIFont(descriptor:descriptor,size:font.pointSize)}
            #endif
            var attributes:[NSAttributedString.Key:Any]=[.font:font,.foregroundColor:color,.paragraphStyle:paragraph]
            if run.style.contains(.strike){attributes[.strikethroughStyle]=NSUnderlineStyle.single.rawValue}
            if run.style.contains(.underline){attributes[.underlineStyle]=NSUnderlineStyle.single.rawValue}
            if run.style.contains(.subscriptText){attributes[.baselineOffset] = -3}
            if run.style.contains(.superscriptText){attributes[.baselineOffset] = 5}
            if run.style.contains(.code)||run.style.contains(.keyboard){attributes[.backgroundColor]=color.withAlphaComponent(run.style.contains(.keyboard) ? 0.09:0.06)}
            if index<links.count,let link=links[index]{attributes[.link]=link}
            result.append(NSAttributedString(string:run.text,attributes:attributes))
        };return result
    }
    static func code(_ text:String,highlight:CodeHighlight?)->NSAttributedString {
        let paragraph=NSMutableParagraphStyle();paragraph.lineSpacing=4
        #if os(macOS)
        let foreground=NSColor.labelColor
        #else
        let foreground=UIColor.label
        #endif
        let result=NSMutableAttributedString(string:text,attributes:[.font:font(.code),.foregroundColor:foreground,.paragraphStyle:paragraph])
        guard let highlight,highlight.text==text else{return result}
        var offset=0
        for token in highlight.tokens {
            let range=NSRange(location:offset,length:token.text.utf16.count);offset += range.length
            var value=token.color;if value.hasPrefix("#"){value.removeFirst()}
            if value.count==6,let rgb=UInt32(value,radix:16){result.addAttribute(.foregroundColor,value:CitationColor(red:CGFloat((rgb>>16)&255)/255,green:CGFloat((rgb>>8)&255)/255,blue:CGFloat(rgb&255)/255,alpha:1),range:range)}
            var font=font(.code)
            #if os(macOS)
            if token.style&1 != 0 {font=NSFontManager.shared.convert(font,toHaveTrait:.italicFontMask)}
            if token.style&2 != 0 {font=NSFontManager.shared.convert(font,toHaveTrait:.boldFontMask)}
            #else
            var traits:UIFontDescriptor.SymbolicTraits=[]
            if token.style&1 != 0 {traits.insert(.traitItalic)}
            if token.style&2 != 0 {traits.insert(.traitBold)}
            if let descriptor=font.fontDescriptor.withSymbolicTraits(traits){font=UIFont(descriptor:descriptor,size:font.pointSize)}
            #endif
            result.addAttribute(.font,value:font,range:range)
            if token.style&4 != 0 {result.addAttribute(.underlineStyle,value:NSUnderlineStyle.single.rawValue,range:range)}
            if token.style&8 != 0 {result.addAttribute(.strikethroughStyle,value:NSUnderlineStyle.single.rawValue,range:range)}
        };return result
    }
}

struct TaskCitationSelectableText:View {
    let value:NSAttributedString
    let part:Int
    var maximumLines:Int?=nil
    @Environment(\.taskCitationDocument) private var model
    @Environment(\.taskCitationPath) private var path
    var body:some View {
        if let model {CitationNativeText(value:value,key:path+[part],group:path,maximumLines:maximumLines,model:model)}
        else {Text(AttributedString(value)).frame(maxWidth:.infinity,alignment:.leading)}
    }
}

#if os(macOS)
private struct CitationNativeText:NSViewRepresentable {
    let value:NSAttributedString;let key:[Int];let group:[Int];let maximumLines:Int?;let model:TaskCitationSelectionModel
    func makeNSView(context:Context)->CitationPartView {CitationPartView(frame:.zero,textContainer:nil)}
    func updateNSView(_ view:CitationPartView,context:Context){view.configure(value,key:key,group:group,lines:maximumLines,model:model)}
    func sizeThatFits(_ proposal:ProposedViewSize,nsView:CitationPartView,context:Context)->CGSize? {nsView.measure(proposal.width)}
    static func dismantleNSView(_ view:CitationPartView,coordinator:()){view.model?.unregister(view)}
}
final class CitationPartView:NSTextView,TaskCitationNativePart {
    var citationKey:[Int]=[],citationGroup:[Int]=[]
    weak var model:TaskCitationSelectionModel?
    var citationView:NSView{self}
    var citationText:String{string}
    override init(frame:NSRect,textContainer:NSTextContainer?){
        if let textContainer {
            super.init(frame:frame,textContainer:textContainer)
        } else {
            // Passing nil to NSTextView's designated initializer creates no
            // text system: textStorage writes are ignored and sizing is zero.
            // Keep a complete TextKit 1 graph for drawing and citation ranges.
            let storage=NSTextStorage(),layout=NSLayoutManager()
            let container=NSTextContainer(containerSize:CGSize(width:1,height:CGFloat.greatestFiniteMagnitude))
            storage.addLayoutManager(layout);layout.addTextContainer(container)
            super.init(frame:frame,textContainer:container)
        }
        isEditable=false;isSelectable=false;drawsBackground=false;textContainerInset = .zero
        self.textContainer?.lineFragmentPadding=0;isVerticallyResizable=true;isHorizontallyResizable=false
        self.textContainer?.widthTracksTextView=false
    }
    required init?(coder:NSCoder){fatalError("init(coder:) has not been implemented")}
    func configure(_ value:NSAttributedString,key:[Int],group:[Int],lines:Int?,model:TaskCitationSelectionModel){
        if self.model !== model || citationKey != key {self.model?.unregister(self)}
        citationKey=key;citationGroup=group;self.model=model
        textContainer?.maximumNumberOfLines=lines ?? 0;textContainer?.lineBreakMode=lines == nil ? .byWordWrapping:.byTruncatingTail
        if textStorage?.isEqual(to:value) != true {textStorage?.setAttributedString(value);invalidateIntrinsicContentSize()}
        model.register(self)
    }
    func measure(_ proposed:CGFloat?)->CGSize{
        guard let container=textContainer,let layout=layoutManager else{return.zero}
        let width=max(1,proposed ?? ceil(attributedString().boundingRect(with:CGSize(width:CGFloat.greatestFiniteMagnitude,height:CGFloat.greatestFiniteMagnitude),options:[.usesLineFragmentOrigin,.usesFontLeading]).width))
        container.containerSize=CGSize(width:width,height:CGFloat.greatestFiniteMagnitude);layout.ensureLayout(for:container)
        return CGSize(width:width,height:max(1,ceil(layout.usedRect(for:container).height)))
    }
    func offset(at point:CGPoint)->Int {guard let layoutManager,let textContainer else{return 0};return layoutManager.characterIndex(for:point,in:textContainer,fractionOfDistanceBetweenInsertionPoints:nil)}
    func rectangles(_ range:NSRange)->[CGRect]{
        guard let layout=layoutManager,let container=textContainer,range.length>0 else{return[]}
        let glyphs=layout.glyphRange(forCharacterRange:range,actualCharacterRange:nil);var values:[CGRect]=[]
        layout.enumerateEnclosingRects(forGlyphRange:glyphs,withinSelectedGlyphRange:glyphs,in:container){rect,_ in values.append(rect)};return values
    }
    func highlight(_ range:NSRange?){
        guard let layoutManager else{return};layoutManager.removeTemporaryAttribute(.backgroundColor,forCharacterRange:NSRange(location:0,length:string.utf16.count))
        if let range,range.length>0 {layoutManager.addTemporaryAttribute(.backgroundColor,value:NSColor.selectedTextBackgroundColor.withAlphaComponent(0.35),forCharacterRange:range)};needsDisplay=true
    }
    func link(at offset:Int)->URL?{guard offset<string.utf16.count else{return nil};let value=textStorage?.attribute(.link,at:max(0,offset),effectiveRange:nil);return value as? URL ?? (value as? String).flatMap(URL.init(string:))}
    func reveal(_ range:NSRange){scrollRangeToVisible(range)}
    func linkRectangles()->[CGRect] {
        var result:[CGRect]=[];textStorage?.enumerateAttribute(.link,in:NSRange(location:0,length:string.utf16.count)) { value,range,_ in if value != nil { result += rectangles(range) } };return result
    }
}
#else
private struct CitationNativeText:UIViewRepresentable{
    let value:NSAttributedString;let key:[Int];let group:[Int];let maximumLines:Int?;let model:TaskCitationSelectionModel
    func makeUIView(context:Context)->CitationPartView {CitationPartView()}
    func updateUIView(_ view:CitationPartView,context:Context){view.configure(value,key:key,group:group,lines:maximumLines,model:model)}
    func sizeThatFits(_ proposal:ProposedViewSize,uiView:CitationPartView,context:Context)->CGSize?{uiView.measure(proposal.width)}
    static func dismantleUIView(_ view:CitationPartView,coordinator:()){view.model?.unregister(view)}
}
private final class CitationPartView:UITextView,TaskCitationNativePart{
    var citationKey:[Int]=[],citationGroup:[Int]=[]
    weak var model:TaskCitationSelectionModel?
    private var selectionLayers:[CALayer]=[]
    private var highlightedRange:NSRange?
    var citationView:UIView{self}
    var citationText:String{text ?? ""}
    init(){super.init(frame:.zero,textContainer:NSTextContainer(size:CGSize(width:1,height:CGFloat.greatestFiniteMagnitude)));isEditable=false;isSelectable=false;isScrollEnabled=false;backgroundColor = .clear;textContainerInset = .zero;textContainer.lineFragmentPadding=0;textContainer.widthTracksTextView=false;contentInsetAdjustmentBehavior = .never}
    required init?(coder:NSCoder){fatalError("init(coder:) has not been implemented")}
    func configure(_ value:NSAttributedString,key:[Int],group:[Int],lines:Int?,model:TaskCitationSelectionModel){
        if self.model !== model || citationKey != key {self.model?.unregister(self)}
        citationKey=key;citationGroup=group;self.model=model
        textContainer.maximumNumberOfLines=lines ?? 0;textContainer.lineBreakMode=lines == nil ? .byWordWrapping:.byTruncatingTail
        if !textStorage.isEqual(to:value){textStorage.setAttributedString(value);invalidateIntrinsicContentSize()}
        model.register(self)
    }
    func measure(_ proposed:CGFloat?)->CGSize{
        let width=max(1,proposed ?? ceil(attributedText.boundingRect(with:CGSize(width:CGFloat.greatestFiniteMagnitude,height:CGFloat.greatestFiniteMagnitude),options:[.usesLineFragmentOrigin,.usesFontLeading],context:nil).width))
        textContainer.size=CGSize(width:width,height:CGFloat.greatestFiniteMagnitude);layoutManager.ensureLayout(for:textContainer)
        return CGSize(width:width,height:max(1,ceil(layoutManager.usedRect(for:textContainer).height)))
    }
    func offset(at point:CGPoint)->Int{layoutManager.characterIndex(for:point,in:textContainer,fractionOfDistanceBetweenInsertionPoints:nil)}
    func rectangles(_ range:NSRange)->[CGRect]{
        guard range.length>0 else{return[]};let glyphs=layoutManager.glyphRange(forCharacterRange:range,actualCharacterRange:nil);var values:[CGRect]=[]
        layoutManager.enumerateEnclosingRects(forGlyphRange:glyphs,withinSelectedGlyphRange:glyphs,in:textContainer){rect,_ in values.append(rect)};return values
    }
    func highlight(_ range:NSRange?){
        highlightedRange=range;selectionLayers.forEach { $0.removeFromSuperlayer() };selectionLayers=[]
        if let range,range.length>0 { for rect in rectangles(range) { let highlight=CALayer();highlight.frame=rect;highlight.backgroundColor=UIColor.systemBlue.withAlphaComponent(0.2).cgColor;layer.addSublayer(highlight);selectionLayers.append(highlight) } }
    }
    override func layoutSubviews() { super.layoutSubviews();highlight(highlightedRange) }
    func link(at offset:Int)->URL?{guard offset<(text ?? "").utf16.count else{return nil};let value=textStorage.attribute(.link,at:max(0,offset),effectiveRange:nil);return value as? URL ?? (value as? String).flatMap(URL.init(string:))}
    func reveal(_ range:NSRange){
        guard let rect=rectangles(range).first else{return};var parent=superview
        while let value=parent {if let scroll=value as? UIScrollView {scroll.scrollRectToVisible(convert(rect,to:scroll),animated:false)};parent=value.superview}
    }
}
#endif
