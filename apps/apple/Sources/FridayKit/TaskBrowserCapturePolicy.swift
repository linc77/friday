import Foundation

enum TaskBrowserCapturePolicy {
    static let frameRates=[30,60]
    static func frameRate(_ value:Int)->Int {frameRates.contains(value) ? value:30}
    static func videoSize(_ size:CGSize)->CGSize {
        guard size.width.isFinite,size.height.isFinite,size.width>0,size.height>0 else{return CGSize(width:2,height:2)}
        let scale=min(1,3840/max(size.width,size.height),sqrt(Double(3840*2160)/(size.width*size.height)))
        return CGSize(width:max(2,floor(size.width*scale/2)*2),height:max(2,floor(size.height*scale/2)*2))
    }
    static func bitRate(width:Int,height:Int,frameRate:Int)->Int {Int(min(50_000_000,max(2_500_000,Double(width)*Double(height)*Double(frameRate)*0.05)).rounded())}
    static func pictureSize(_ current:CGSize,aspect:Double)->CGSize {
        guard aspect.isFinite,aspect>0 else{return current}
        let area=max(1,current.width)*max(1,current.height),width=sqrt(area*aspect),height=width/aspect,scale=max(1,240/width,160/height)
        return CGSize(width:(width*scale).rounded(),height:(height*scale).rounded())
    }
    static func siteSlug(_ raw:String)->String {
        guard let host=URL(string:raw)?.host else{return "site"}
        let value=host.lowercased().replacingOccurrences(of:"[^a-z0-9]+",with:"-",options:.regularExpression).trimmingCharacters(in:CharacterSet(charactersIn:"-"))
        return String(value.prefix(80)).trimmingCharacters(in:CharacterSet(charactersIn:"-")).isEmpty ? "site":String(value.prefix(80)).trimmingCharacters(in:CharacterSet(charactersIn:"-"))
    }
    static func fileName(page:String,recording:Bool,date:Date=Date(),id:UUID=UUID())->String {
        let stamp=String(Int64(date.timeIntervalSince1970*1000),radix:36),suffix=String(id.uuidString.lowercased().prefix(8))
        return recording ? "browser-recording-\(stamp)-\(suffix).mp4":"browser-screenshot-\(siteSlug(page))-\(stamp)-\(suffix).png"
    }
}
enum TaskBrowserRecordingPhase:Equatable {case starting,recording,stopping,finished}
struct TaskBrowserRecordingLifecycle {
    private(set) var phase:TaskBrowserRecordingPhase = .starting
    private(set) var started:Double?
    mutating func firstFrame(at time:Double)->Bool {guard phase == .starting,time.isFinite else{return false};started=time;phase = .recording;return true}
    mutating func stop()->Bool {guard phase == .starting || phase == .recording else{return false};phase = .stopping;return true}
    mutating func finish() {phase = .finished}
    var acceptsFrames:Bool {phase == .starting || phase == .recording}
    func elapsed(at time:Double)->Double {started.map {max(0,time-$0)} ?? 0}
}
