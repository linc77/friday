import Foundation
import CoreGraphics
import ImageIO

struct TaskHostBrowserSettings:Codable,Equatable {
    var width:Int;var height:Int;var mobile:Bool;var zoom:Double;var appearance:String
    init(tab:TaskBrowserTab,width:Int=1280,height:Int=800) {self.width=tab.viewportWidth ?? width;self.height=tab.viewportHeight ?? height;mobile=tab.mobile;zoom=tab.zoom;appearance=tab.appearance}
    var body:[String:Any] {["width":width,"height":height,"mobile":mobile,"zoom":zoom,"appearance":appearance]}
    var layout:CGSize {CGSize(width:max(1,(Double(width)/zoom).rounded()),height:max(1,(Double(height)/zoom).rounded()))}
}
struct TaskHostBrowserSnapshot:Decodable,Equatable {
    struct Dialog:Decodable,Equatable,Identifiable {let id:String;let type:String;let message:String;let defaultValue:String}
    struct Popup:Decodable,Equatable {let tabId:String;let url:String;let generation:String?}
    struct Chooser:Decodable,Equatable,Identifiable {let id:String;let multiple:Bool;let accept:String;let offeredTo:String?}
    struct Download:Decodable,Equatable,Identifiable {let id:String;let fileName:String;let sizeBytes:Int64;let status:String;let completedAt:String?;let error:String?;let offeredTo:String?}
    let taskId:String;let tabId:String;let generation:String;let revision:Int;let url:String;let title:String
    let loading:Bool;let back:Bool;let forward:Bool;let error:String?;let settings:TaskHostBrowserSettings
    let controller:String?;let controlGeneration:Int;let dialog:Dialog?;let popups:[Popup]
    let chooser:Chooser?;let downloads:[Download]?
    var clipboardText:String?
    let documentId:String?
}
struct TaskHostBrowserRecordingAck:Decodable {let inputs:[TaskBrowserRecordingInput]?}
struct TaskHostBrowserEnvelope:Decodable {
    let type:String;let state:TaskHostBrowserSnapshot?;let data:String?;let width:Int?;let height:Int?;let sequence:Int?
}
struct TaskHostBrowserStream {
    let task:String;let tab:String;let generation:String
    private(set) var revision = -1
    private(set) var sequence = -1
    mutating func read(_ line:String)throws->TaskHostBrowserEnvelope? {
        guard line.hasPrefix("data:"),line.utf8.count<=12*1024*1024 else{return nil}
        let value=try JSONDecoder().decode(TaskHostBrowserEnvelope.self,from:Data(line.dropFirst(5).utf8))
        if value.type=="state" {
            guard let state=value.state,state.taskId==task,state.tabId==tab,state.generation==generation,state.revision>=revision else{return nil};revision=state.revision
        }else if value.type=="frame" {
            guard let next=value.sequence,next>sequence,let width=value.width,let height=value.height,width>=1,height>=1,width<=15360,height<=15360,width*height<=3840*2160*16,let data=value.data,data.utf8.count<=8*1024*1024 else{return nil};sequence=next
        }else if value.type != "gone" {return nil}
        return value
    }
}
enum TaskHostBrowserGeometry {
    static func frame(container:CGSize,viewport:CGSize)->CGRect {
        guard container.width>0,container.height>0,viewport.width>0,viewport.height>0 else{return .zero}
        let factor=min(container.width/viewport.width,container.height/viewport.height),size=CGSize(width:viewport.width*factor,height:viewport.height*factor)
        return CGRect(x:(container.width-size.width)/2,y:(container.height-size.height)/2,width:size.width,height:size.height)
    }
    static func point(_ point:CGPoint,frame:CGRect,viewport:CGSize,clamped:Bool=false)->CGPoint? {
        guard frame.width>0,frame.height>0,clamped || frame.contains(point) else{return nil}
        return CGPoint(x:min(viewport.width,max(0,(point.x-frame.minX)/frame.width*viewport.width)),y:min(viewport.height,max(0,(point.y-frame.minY)/frame.height*viewport.height)))
    }
    static func decode(_ data:Data,maxBytes:Int=6*1024*1024)->CGImage? {
        guard data.count<=maxBytes,let source=CGImageSourceCreateWithData(data as CFData,nil),let properties=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],let width=properties[kCGImagePropertyPixelWidth] as? Int,let height=properties[kCGImagePropertyPixelHeight] as? Int,width>0,height>0,width<=7680,height<=4320,width*height<=3840*2160*4 else{return nil}
        return CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary)
    }
}
