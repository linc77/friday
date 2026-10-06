// Run from the repository root: swift scripts/build-icons.swift
// Converts the approved master into platform assets; does not generate artwork.
import AppKit

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let files = FileManager.default
let master = root.appendingPathComponent("assets/brand/friday-logo.png")
guard let artwork = NSImage(contentsOf: master) else {
    fatalError("Missing icon master: \(master.path)")
}
let glassMaster = root.appendingPathComponent("assets/brand/friday-glass.png")
guard let glassArtwork = NSImage(contentsOf: glassMaster) else {
    fatalError("Missing translucent macOS icon master: \(glassMaster.path)")
}

func writePNG(size: Int, to url: URL, macOS: Bool = false) throws {
    let alpha = macOS ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast
    let canvas = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: alpha.rawValue
    )!
    let context = NSGraphicsContext(cgContext: canvas, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let bounds = NSRect(x: 0, y: 0, width: size, height: size)
    if macOS {
        NSColor.clear.setFill()
        bounds.fill(using: .copy)
        let scale = CGFloat(size) / 1024
        // Match standard Dock footprints and preserve the glass master's alpha.
        // A white underlay would make the translucent backing opaque again.
        let tile = bounds.insetBy(dx: 112 * scale, dy: 112 * scale)
        let shape = NSBezierPath(roundedRect: tile, xRadius: 176 * scale, yRadius: 176 * scale)
        shape.addClip()
        // Trim the generated source's outer margin before applying the native mask.
        let source = NSRect(origin: .zero, size: glassArtwork.size)
            .insetBy(dx: glassArtwork.size.width * 0.055, dy: glassArtwork.size.height * 0.055)
        glassArtwork.draw(in: tile, from: source, operation: .sourceOver, fraction: 1)
    } else {
        // iOS supplies the icon mask; its source must be full bleed and opaque.
        NSColor.white.setFill()
        bounds.fill()
        artwork.draw(in: bounds)
    }
    NSGraphicsContext.restoreGraphicsState()
    let bitmap = NSBitmapImageRep(cgImage: canvas.makeImage()!)
    try files.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try bitmap.representation(using: .png, properties: [:])!.write(to: url)
}

try writePNG(size: 256, to: root.appendingPathComponent("apps/apple/Sources/FridayKit/Resources/FridayLogo.png"))
try writePNG(size: 1024, to: root.appendingPathComponent("assets/brand/friday-mac-icon.png"), macOS: true)

let catalog = root.appendingPathComponent("apps/ios/Friday/Assets.xcassets")
let appIcon = catalog.appendingPathComponent("AppIcon.appiconset")
var images: [[String: String]] = []
let slots: [(String, Int, [Int])] = [
    ("iphone", 20, [2, 3]), ("iphone", 29, [2, 3]),
    ("iphone", 40, [2, 3]), ("iphone", 60, [2, 3]),
    ("ipad", 20, [1, 2]), ("ipad", 29, [1, 2]),
    ("ipad", 40, [1, 2]), ("ipad", 76, [1, 2])
]
for (idiom, points, scales) in slots {
    for scale in scales {
        let filename = "icon-\(points * scale).png"
        try writePNG(size: points * scale, to: appIcon.appendingPathComponent(filename))
        images.append(["idiom": idiom, "size": "\(points)x\(points)", "scale": "\(scale)x", "filename": filename])
    }
}
try writePNG(size: 167, to: appIcon.appendingPathComponent("icon-167.png"))
images.append(["idiom": "ipad", "size": "83.5x83.5", "scale": "2x", "filename": "icon-167.png"])
try writePNG(size: 1024, to: appIcon.appendingPathComponent("icon-1024.png"))
images.append(["idiom": "ios-marketing", "size": "1024x1024", "scale": "1x", "filename": "icon-1024.png"])
let info: [String: Any] = ["author": "xcode", "version": 1]
try JSONSerialization.data(withJSONObject: ["images": images, "info": info], options: [.prettyPrinted, .sortedKeys])
    .write(to: appIcon.appendingPathComponent("Contents.json"))
try JSONSerialization.data(withJSONObject: ["info": info], options: [.prettyPrinted, .sortedKeys])
    .write(to: catalog.appendingPathComponent("Contents.json"))

let temporary = files.temporaryDirectory.appendingPathComponent("friday-icons-\(UUID().uuidString)")
let iconset = temporary.appendingPathComponent("Friday.iconset")
defer { try? files.removeItem(at: temporary) }
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        try writePNG(size: points * scale, to: iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png"), macOS: true)
    }
}
let icns = root.appendingPathComponent("apps/apple/Assets/Friday.icns")
try files.createDirectory(at: icns.deletingLastPathComponent(), withIntermediateDirectories: true)
let convert = Process()
convert.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
convert.arguments = ["-c", "icns", iconset.path, "-o", icns.path]
try convert.run()
convert.waitUntilExit()
guard convert.terminationStatus == 0 else { fatalError("iconutil failed") }
print("Updated Friday's macOS icon, iOS app icon catalog, and in-app logo.")
