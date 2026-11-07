import Foundation
import CoreGraphics
import CoreText

struct TaskBrowserRecordingInput:Decodable {
    let nonce:String;let document:String;let type:String;let width:Double;let height:Double
    let x:Double?;let y:Double?;let phase:String?;let label:String?;let held:Bool?
}
struct TaskBrowserRecordingDecorations {
    struct Pointer {var x:Double;var y:Double;var width:Double;var height:Double}
    struct Ring {var point:Pointer;var held:Bool;var released:Double?}
    struct Key {let label:String;let width:Double;let expires:Double?}
    let showKeys:Bool;let showMouse:Bool
    private(set) var pointer:Pointer?
    private(set) var ring:Ring?
    private(set) var key:Key?
    mutating func clear() {pointer=nil;ring=nil;key=nil}
    mutating func apply(_ input:TaskBrowserRecordingInput,now:Double) {
        if input.type=="clear" {clear();return}
        guard input.width.isFinite,input.height.isFinite,input.width>0,input.height>0,input.width<=100_000,input.height<=100_000,now.isFinite else{return}
        if input.type=="key",showKeys {
            key=input.label.flatMap {label in label.isEmpty || label.utf16.count>160 ? nil:Key(label:label,width:input.width,expires:input.held==true ? nil:now+0.9)}
        }else if input.type=="pointer",let x=input.x,let y=input.y,x.isFinite,y.isFinite,abs(x)<=100_000,abs(y)<=100_000 {
            let point=Pointer(x:x,y:y,width:input.width,height:input.height);pointer=point
            if showMouse {
                if input.phase=="down" || input.phase=="click" {ring=Ring(point:point,held:input.phase=="down",released:input.phase=="click" ? now:nil)}
                else if ring?.held==true {ring=Ring(point:point,held:input.phase != "up",released:input.phase=="up" ? now:nil)}
            }
        }
    }
    func ringProgress(now:Double)->Double? {guard let ring else{return nil};if ring.held {return 0};guard let released=ring.released,now<released+0.6 else{return nil};return min(1,max(0,(now-released)/0.6))}
    func visibleKey(now:Double)->String? {guard let key,key.expires==nil || now<key.expires! else{return nil};return key.label}
    func draw(in context:CGContext,rect:CGRect,now:Double) {
        context.saveGState();context.translateBy(x:rect.minX,y:rect.maxY);context.scaleBy(x:1,y:-1)
        if let ring,let progress=ringProgress(now:now) {
            let point=ring.point,scaleX=rect.width/point.width,scaleY=rect.height/point.height,rx=20*scaleX*(1+progress*0.5),ry=20*scaleY*(1+progress*0.5)
            let oval=CGRect(x:point.x*scaleX-rx,y:point.y*scaleY-ry,width:rx*2,height:ry*2)
            context.setFillColor(CGColor(red:0.15,green:0.39,blue:0.92,alpha:0.9*(1-progress)*0.15));context.fillEllipse(in:oval)
            context.setStrokeColor(CGColor(red:0.15,green:0.39,blue:0.92,alpha:0.9*(1-progress)));context.setLineWidth(max(1,2*scaleX));context.strokeEllipse(in:oval)
        }
        if let point=pointer {
            let scale=rect.width/point.width;context.saveGState();context.translateBy(x:point.x*scale,y:point.y*rect.height/point.height);context.scaleBy(x:scale,y:scale)
            let path=CGMutablePath();path.move(to:CGPoint(x:1,y:1));for p in [CGPoint(x:1,y:19),CGPoint(x:5,y:15),CGPoint(x:9,y:23),CGPoint(x:12,y:21.5),CGPoint(x:8,y:13),CGPoint(x:15,y:13)] {path.addLine(to:p)};path.closeSubpath()
            context.setFillColor(CGColor(gray:0,alpha:1));context.setStrokeColor(CGColor(gray:1,alpha:1));context.setLineWidth(1.5);context.addPath(path);context.drawPath(using:.fillStroke);context.restoreGState()
        }
        context.restoreGState()
        if let label=visibleKey(now:now),let key {
            let scale=rect.width/key.width,font=CTFontCreateUIFontForLanguage(.system,CGFloat(26*scale),nil)!
            let attrs:[NSAttributedString.Key:Any]=[NSAttributedString.Key(kCTFontAttributeName as String):font,NSAttributedString.Key(kCTForegroundColorAttributeName as String):CGColor(gray:1,alpha:1)]
            let line=CTLineCreateWithAttributedString(NSAttributedString(string:label,attributes:attrs)),textWidth=CTLineGetTypographicBounds(line,nil,nil,nil)
            let width=min(rect.width-32*scale,max(68*scale,textWidth+32*scale)),height=48*scale,badge=CGRect(x:rect.midX-width/2,y:rect.minY+28*scale,width:width,height:height)
            context.saveGState();context.setFillColor(CGColor(gray:0.05,alpha:0.85));context.addPath(CGPath(roundedRect:badge,cornerWidth:10*scale,cornerHeight:10*scale,transform:nil));context.fillPath()
            context.textMatrix = .identity;context.textPosition=CGPoint(x:badge.midX-textWidth/2,y:badge.midY-9*scale);CTLineDraw(line,context);context.restoreGState()
        }
    }
}
