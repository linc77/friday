// Run from the repository root: swift scripts/build-icons.swift
// Renders the polygon SVG master directly at each platform size.
import AppKit

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let files = FileManager.default
let master = root.appendingPathComponent("assets/brand/friday-logo.svg")
let document = try XMLDocument(contentsOf: master, options: .nodeLoadExternalEntitiesNever)
guard let svg = document.rootElement(),
      svg.attribute(forName: "viewBox")?.stringValue == "0 0 1024 1024" else {
    fatalError("Expected a 1024-square SVG master: \(master.path)")
}
// This master deliberately uses only flat polygons. Curves and raster tracing
// cannot enter the exported logo, and every size renders from the same vertices.
let masterSize: CGFloat = 1024
let polygons: [(path: CGPath, white: Bool)] = svg.elements(forName: "polygon").map { element in
    guard let points = element.attribute(forName: "points")?.stringValue,
          let fill = element.attribute(forName: "fill")?.stringValue,
          fill == "#FFFFFF" || fill == "#000000" else {
        fatalError("Logo polygons require points and a black or white fill.")
    }
    let tokens = points.split { $0 == "," || $0.isWhitespace }
    let coordinates = tokens.compactMap { Double($0) }
    guard coordinates.count == tokens.count, coordinates.count >= 6,
          coordinates.count.isMultiple(of: 2), coordinates.allSatisfy({ $0.isFinite }) else {
        fatalError("Invalid logo polygon: \(points)")
    }
    let path = CGMutablePath()
    for offset in stride(from: 0, to: coordinates.count, by: 2) {
        // SVG uses a top-left origin; native bitmap drawing uses bottom-left.
        let point = CGPoint(x: coordinates[offset], y: Double(masterSize) - coordinates[offset + 1])
        if offset == 0 { path.move(to: point) } else { path.addLine(to: point) }
    }
    path.closeSubpath()
    return (path, fill == "#FFFFFF")
}
guard polygons.count == 2, polygons[0].white, !polygons[1].white else {
    fatalError("Expected the white V followed by its black cutout.")
}
let glyphLevel: CGFloat = 230 // #E6E6E6, matching the softer whites in the Dock references.

func writePNG(size: Int, to url: URL, macOS: Bool = false, masterPreview: Bool = false) throws {
    let alpha = macOS ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast
    let canvas = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: alpha.rawValue
    )!
    let bounds = CGRect(x: 0, y: 0, width: size, height: size)
    let tile: CGRect
    if macOS {
        canvas.clear(bounds)
        let scale = CGFloat(size) / 1024
        // Match the approved Dock footprint; only the outer margin is transparent.
        tile = bounds.insetBy(dx: 112 * scale, dy: 112 * scale)
        canvas.addPath(CGPath(roundedRect: tile, cornerWidth: 176 * scale, cornerHeight: 176 * scale, transform: nil))
        canvas.clip()
    } else {
        // iOS supplies the icon mask; its source must be full bleed and opaque.
        tile = bounds
    }
    canvas.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
    canvas.fill(tile)
    // Keep the existing platform proportions; the PNG preview shows the full SVG.
    let margin: CGFloat = masterPreview ? 0 : masterSize * 0.055
    let artworkBounds = CGRect(x: margin, y: margin, width: masterSize - 2 * margin, height: masterSize - 2 * margin)
    canvas.translateBy(x: tile.minX, y: tile.minY)
    canvas.scaleBy(x: tile.width / artworkBounds.width, y: tile.height / artworkBounds.height)
    canvas.translateBy(x: -artworkBounds.minX, y: -artworkBounds.minY)
    let white = (masterPreview ? 255 : glyphLevel) / 255
    for polygon in polygons {
        let level = polygon.white ? white : 0
        canvas.setFillColor(red: level, green: level, blue: level, alpha: 1)
        canvas.addPath(polygon.path)
        canvas.fillPath()
    }
    let bitmap = NSBitmapImageRep(cgImage: canvas.makeImage()!)
    try files.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try bitmap.representation(using: .png, properties: [:])!.write(to: url)
}

try writePNG(size: 1024, to: root.appendingPathComponent("assets/brand/friday-logo.png"), masterPreview: true)
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
