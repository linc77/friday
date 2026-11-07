// Viewport data from pingdotgg/t3code@8cd9641f, shared/previewViewport.ts.
import Foundation

struct TaskBrowserViewportPreset:Identifiable {let id:String;let label:String;let width:Int;let height:Int;let mobile:Bool
    static let all:[Self]=[
        .init(id:"iphone-se",label:"iPhone SE",width:375,height:667,mobile:true),
        .init(id:"iphone-xr",label:"iPhone XR",width:414,height:896,mobile:true),
        .init(id:"iphone-12-pro",label:"iPhone 12 Pro",width:390,height:844,mobile:true),
        .init(id:"iphone-14-pro-max",label:"iPhone 14 Pro Max",width:430,height:932,mobile:true),
        .init(id:"pixel-7",label:"Pixel 7",width:412,height:915,mobile:true),
        .init(id:"samsung-galaxy-s8-plus",label:"Samsung Galaxy S8+",width:360,height:740,mobile:true),
        .init(id:"samsung-galaxy-s20-ultra",label:"Samsung Galaxy S20 Ultra",width:412,height:915,mobile:true),
        .init(id:"ipad-mini",label:"iPad Mini",width:768,height:1024,mobile:true),
        .init(id:"ipad-air",label:"iPad Air",width:820,height:1180,mobile:true),
        .init(id:"ipad-pro",label:"iPad Pro",width:1024,height:1366,mobile:true),
        .init(id:"surface-pro-7",label:"Surface Pro 7",width:912,height:1368,mobile:true),
        .init(id:"surface-duo",label:"Surface Duo",width:540,height:720,mobile:true),
        .init(id:"galaxy-z-fold-5",label:"Galaxy Z Fold 5",width:344,height:882,mobile:true),
        .init(id:"asus-zenbook-fold",label:"Asus Zenbook Fold",width:853,height:1280,mobile:true),
        .init(id:"samsung-galaxy-a51-71",label:"Samsung Galaxy A51/71",width:412,height:914,mobile:true),
        .init(id:"nest-hub",label:"Nest Hub",width:1024,height:600,mobile:true),
        .init(id:"nest-hub-max",label:"Nest Hub Max",width:1280,height:800,mobile:true),
    ]
}
