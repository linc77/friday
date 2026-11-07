import Foundation

struct TaskMediaSource: Equatable { let url: URL; let revision: String }
struct TaskMediaPlaybackState {
    private(set) var current: TaskMediaSource?
    private(set) var latest: TaskMediaSource?
    private(set) var playing = false
    private(set) var hasPlayed = false
    mutating func update(_ source: TaskMediaSource) -> TaskMediaSource? {
        latest = source
        guard current == nil || !hasPlayed && current?.url != source.url || !playing && current?.revision != source.revision else { return nil }
        current = source; hasPlayed = false; return source
    }
    mutating func event(_ event: String) -> TaskMediaSource? {
        switch event {
        case "play": playing = true; hasPlayed = true
        case "pause", "ended": playing = false
        case "error":
            playing = false
            if let latest, latest != current { current = latest; hasPlayed = false; return latest }
            return nil
        default: return nil
        }
        guard !playing, let latest, current?.revision != latest.revision else { return nil }
        current = latest; hasPlayed = false; return latest
    }
}

enum TaskWorkspaceMediaPolicy {
    static func wrapper(url: URL, name: String, video: Bool, documentID: String, actions: Bool = false, requiresCapability: Bool = true, inline: Bool = false) -> String? {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, url.user == nil, url.password == nil,
              (!requiresCapability || url.path.hasPrefix("/file-assets/")), !documentID.isEmpty, documentID.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 }) else { return nil }
        func escape(_ text: String) -> String { text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;") }
        let tag = video ? "video" : "audio"
        var origin = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        origin.path = ""; origin.query = nil; origin.fragment = nil
        guard let originURL = origin.url else { return nil }
        return """
        <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src \(requiresCapability ? escape(originURL.absoluteString) + "/file-assets/" : "http: https:"); script-src 'nonce-\(documentID)'; style-src 'unsafe-inline'">
        <style>:root{color-scheme:light dark}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:transparent}body{display:flex;align-items:center;justify-content:center;padding:\(inline ? 0 : video ? 16 : 24)px}video{aspect-ratio:16/9;max-width:\(inline ? 480 : 1024)px;max-height:100%;width:100%;object-fit:contain;background:black;\(inline ? "border-radius:8px;border:1px solid #8885" : "")}audio{width:100%;max-width:576px}video,audio{cursor:pointer}</style></head>
        <body><\(tag) id="media" controls playsinline preload="\(inline ? "none" : "metadata")"\(requiresCapability ? " crossorigin=\"anonymous\"" : "") src="\(escape(url.absoluteString))" aria-label="\(escape(name))"></\(tag)>
        <script nonce="\(documentID)">(()=>{'use strict';const media=document.getElementById('media');const post=event=>window.webkit.messageHandlers.fridayMedia.postMessage({id:'\(documentID)',event});for(const event of ['play','pause','ended','error'])media.addEventListener(event,()=>post(event));
        media.addEventListener('loadedmetadata',()=>{if(media.tagName==='VIDEO'&&!media.autoplay&&media.paused&&!media.seeking&&media.currentTime===0&&media.played.length===0&&Number.isFinite(media.duration)&&media.duration>0&&!new URLSearchParams(media.src.split('#')[1]||'').has('t')){try{media.currentTime=Math.min(.1,media.duration/2)}catch{}}});
        if(\(actions ? "true" : "false")){const menu=(x,y)=>window.webkit.messageHandlers.fridayMedia.postMessage({id:'\(documentID)',event:'context',x,y});media.addEventListener('contextmenu',event=>{if(event.defaultPrevented)return;event.preventDefault();event.stopPropagation();const b=media.getBoundingClientRect();menu(event.clientX||event.clientY?event.clientX:b.left,event.clientX||event.clientY?event.clientY:b.bottom)});media.tabIndex=0;media.addEventListener('keydown',event=>{if(event.defaultPrevented||!(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'))return;event.preventDefault();event.stopPropagation();const b=media.getBoundingClientRect();menu(b.left,b.bottom)})}
        document.addEventListener('visibilitychange',()=>{if(document.hidden&&!document.fullscreenElement&&!media.webkitDisplayingFullscreen)media.pause()});})();</script></body></html>
        """
    }
}
