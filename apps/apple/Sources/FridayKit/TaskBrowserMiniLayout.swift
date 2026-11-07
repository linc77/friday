import Foundation

struct TaskBrowserMiniSize:Codable,Equatable {var width:Double;var height:Double}
struct TaskBrowserMiniPoint:Codable,Equatable {var x:Double;var y:Double}
struct TaskBrowserMiniFrame:Codable,Equatable {
    var x:Double;var y:Double;var width:Double;var height:Double
    var point:TaskBrowserMiniPoint {.init(x:x,y:y)}
    var size:TaskBrowserMiniSize {.init(width:width,height:height)}
}
struct TaskBrowserMiniObstacle:Codable,Equatable {var left:Double;var right:Double;var height:Double?;var bottom:Double?}
struct TaskBrowserMiniObstacles:Codable,Equatable {
    var composer:TaskBrowserMiniObstacle?=nil
    var detailsCard:TaskBrowserMiniObstacle?=nil
}
struct TaskBrowserFloatingState:Equatable {
    let tabID:String
    let source:TaskBrowserMiniSize
    var width:Double?
    var position:TaskBrowserMiniPoint?
    var lastInteraction="drag"
    var host=false
    mutating func move(source:String,position:TaskBrowserMiniPoint) {guard source==tabID,position.x.isFinite,position.y.isFinite else{return};self.position=position;lastInteraction="drag"}
    mutating func resize(source:String,width:Double,position:TaskBrowserMiniPoint) {guard source==tabID,width.isFinite,width>0,position.x.isFinite,position.y.isFinite else{return};self.width=width;self.position=position;lastInteraction="resize"}
}
enum TaskBrowserMiniLayout {
    static let gap=12.0
    private static func overlap(_ left:Double,_ right:Double,_ item:TaskBrowserMiniObstacle)->Bool {left<item.right && right>item.left}
    private static func floor(_ x:Double,_ width:Double,_ container:TaskBrowserMiniSize,_ obstacles:TaskBrowserMiniObstacles)->Double {
        if let item=obstacles.composer,overlap(x,x+width,item) {return container.height-max(0,item.height ?? 0)};return container.height
    }
    private static func ceiling(_ x:Double,_ width:Double,_ obstacles:TaskBrowserMiniObstacles)->Double {
        if let item=obstacles.detailsCard,overlap(x,x+width,item) {return max(0,item.bottom ?? 0)};return 0
    }
    private static func available(_ container:TaskBrowserMiniSize,_ obstacles:TaskBrowserMiniObstacles,_ span:(Double,Double)?)->TaskBrowserMiniSize {
        let height=span.map {floor($0.0,$0.1,container,obstacles)-ceiling($0.0,$0.1,obstacles)} ?? (container.height-max(0,obstacles.composer?.height ?? 0))
        return .init(width:container.width-gap*2,height:height-gap*2)
    }
    private static func fit(_ desired:Double,_ source:TaskBrowserMiniSize,_ maxSize:TaskBrowserMiniSize)->TaskBrowserMiniSize {
        let aspect=source.width/source.height,width=min(max(desired,240,150*aspect),max(1,maxSize.width),max(1,maxSize.height*aspect))
        return .init(width:Foundation.floor(width+0.5),height:Foundation.floor(width/aspect+0.5))
    }
    private static func inside(_ point:TaskBrowserMiniPoint,_ container:TaskBrowserMiniSize,_ player:TaskBrowserMiniSize,_ minimumX:Double)->TaskBrowserMiniPoint {
        .init(x:min(max(point.x,minimumX,gap),max(gap,container.width-player.width-gap)),y:min(max(point.y,gap),max(gap,container.height-player.height-gap)))
    }
    private static func obstructed(_ p:TaskBrowserMiniPoint,_ player:TaskBrowserMiniSize,_ container:TaskBrowserMiniSize,_ o:TaskBrowserMiniObstacles)->Bool {p.y+player.height>floor(p.x,player.width,container,o) || p.y<ceiling(p.x,player.width,o)}
    static func clamp(_ point:TaskBrowserMiniPoint,container:TaskBrowserMiniSize,player:TaskBrowserMiniSize,obstacles:TaskBrowserMiniObstacles = .init(),minimumX:Double=12)->TaskBrowserMiniPoint {
        let p=inside(point,container,player,minimumX);if !obstructed(p,player,container,obstacles) {return p}
        func row(_ x:Double)->TaskBrowserMiniPoint {.init(x:x,y:min(container.height-gap-player.height,max(min(p.y,floor(x,player.width,container,obstacles)-gap-player.height),ceiling(x,player.width,obstacles)+gap,gap)))}
        var best=row(p.x),distance=obstructed(best,player,container,obstacles) ? Double.infinity:abs(best.y-p.y)
        let beside=[obstacles.composer,obstacles.detailsCard].compactMap {$0}.filter {overlap(p.x,p.x+player.width,$0)}.flatMap {[$0.left-gap-player.width,$0.right+gap]}
        for x in beside {
            let candidate=row(x)
            if inside(candidate,container,player,minimumX).x != x || obstructed(candidate,player,container,obstacles) {continue}
            let d=abs(x-p.x)+abs(candidate.y-p.y);if d<distance {best=candidate;distance=d}
        };return best
    }
    static func resolve(width:Double?,position:TaskBrowserMiniPoint?,source:TaskBrowserMiniSize,container:TaskBrowserMiniSize,obstacles:TaskBrowserMiniObstacles = .init())->TaskBrowserMiniFrame {
        let source=source.width>0 && source.height>0 ? source:TaskBrowserMiniSize(width:1280,height:800)
        let explicit=position != nil && width != nil && width != 0
        var sizing=obstacles;if explicit {sizing.detailsCard=nil}
        let size=fit(width ?? min(320,320*source.width/source.height),source,available(container,sizing,explicit ? (position!.x,width!):nil))
        let anchor=position ?? obstacles.detailsCard.map {.init(x:$0.right-size.width,y:($0.bottom ?? 0)+gap)} ?? .init(x:container.width-gap-size.width,y:gap)
        let p=clamp(anchor,container:container,player:size,obstacles:obstacles)
        return .init(x:p.x,y:p.y,width:size.width,height:size.height)
    }
    static func resize(start:TaskBrowserMiniFrame,direction:String,delta:TaskBrowserMiniPoint,source:TaskBrowserMiniSize,container:TaskBrowserMiniSize,obstacles:TaskBrowserMiniObstacles = .init())->TaskBrowserMiniFrame {
        let east=direction.contains("east"),west=direction.contains("west"),north=direction.contains("north"),south=direction.contains("south"),right=start.x+start.width,bottom=start.y+start.height
        let f=floor(start.x,start.width,container,obstacles),c=ceiling(start.x,start.width,obstacles)
        let maximum=TaskBrowserMiniSize(width:west ? right-gap:east ? container.width-gap-start.x:container.width-gap*2,height:north ? bottom-c-gap:south ? f-gap-start.y:f-c-gap*2)
        let w=start.width+(east ? delta.x:west ? -delta.x:0),h=start.height+(south ? delta.y:north ? -delta.y:0),aspect=source.width/source.height
        let desired=(east || west) && (north || south) ? (w+h/aspect)/(1+1/pow(aspect,2)):(east || west) ? w:h*aspect
        let size=fit(desired,source,maximum),position=clamp(.init(x:west ? right-size.width:start.x,y:north ? bottom-size.height:start.y),container:container,player:size,obstacles:obstacles)
        return .init(x:position.x,y:position.y,width:size.width,height:size.height)
    }
}
