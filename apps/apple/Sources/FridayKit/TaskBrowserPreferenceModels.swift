import Foundation

struct TaskBrowserProfile:Codable,Equatable,Identifiable {
    let id:String
    var name:String
    var kind:String?=nil
    var builtIn:Bool {["default","incognito"].contains(id)}
    static let builtIns=[Self(id:"default",name:"Default",kind:"persistent"),Self(id:"incognito",name:"Incognito",kind:"incognito")]
    static func resolve(_ user:[Self])->[Self] {
        var seen=Set(builtIns.map(\.id)),result=builtIns
        for var item in user where validID(item.id) && !seen.contains(item.id) {
            seen.insert(item.id);item.kind="persistent";item.name=limit(item.name.trimmingCharacters(in:.whitespacesAndNewlines),48)
            if !item.name.isEmpty {result.append(item)}
        }
        return result
    }
    static func validID(_ id:String)->Bool {!id.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && id==id.trimmingCharacters(in:.whitespacesAndNewlines) && id.utf16.count<=64 && id.range(of:#"\p{Cc}"#,options:.regularExpression)==nil}
    static func limit(_ value:String,_ max:Int)->String {var result="",length=0;for scalar in value.unicodeScalars {let count=scalar.value>0xffff ? 2:1;if length+count>max {break};result.unicodeScalars.append(scalar);length+=count};return result}
}
struct TaskBrowserDefaults:Codable,Equatable {
    var profile="default"
    var zoom=1.0
    var appearance="system"
    var width:Int?
    var height:Int?
    var mobile=false
    mutating func validate(profiles:[TaskBrowserProfile]) {
        if !profiles.contains(where:{$0.id==profile && $0.id != "incognito"}) {profile="default"}
        if !zoom.isFinite {zoom=1};zoom=min(5,max(0.25,zoom))
        if !["system","light","dark"].contains(appearance) {appearance="system"}
        if let w=width,let h=height {width=min(3840,max(240,w));height=min(3840,max(240,h));if width!*height!>3840*2160 {height=3840*2160/width!}}else{width=nil;height=nil;mobile=false}
    }
}
