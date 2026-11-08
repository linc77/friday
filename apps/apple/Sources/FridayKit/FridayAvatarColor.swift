import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct FridayAvatarColor: Equatable {
    let red: Double
    let green: Double
    let blue: Double

    static let bodyDefault = "155DFF"
    static let eyeDefault = "000000"
    static let bowTieDefault = "000000"

    init?(hex: String) {
        let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        red = Double((value >> 16) & 0xff) / 255
        green = Double((value >> 8) & 0xff) / 255
        blue = Double(value & 0xff) / 255
    }

    var color: Color { Color(red: red, green: green, blue: blue) }

    static let black = FridayAvatarColor(hex: "000000")!

    static func hex(for color: Color) -> String {
        #if os(macOS)
        let resolved = NSColor(color).usingColorSpace(.sRGB) ?? .systemBlue
        let components = (resolved.redComponent, resolved.greenComponent, resolved.blueComponent)
        #else
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        let components = (red, green, blue)
        #endif
        func byte(_ value: CGFloat) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
        return String(format: "%02X%02X%02X", byte(components.0), byte(components.1), byte(components.2))
    }
}
