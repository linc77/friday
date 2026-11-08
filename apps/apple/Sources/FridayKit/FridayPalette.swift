import SwiftUI
import Observation
#if os(macOS)
import AppKit
typealias FridayNativeColor = NSColor
#else
import UIKit
typealias FridayNativeColor = UIColor
#endif

/// Observable tokens also invalidate views when Dark changes to Midnight,
/// where the system color scheme itself stays dark. No view identities change.
@Observable final class FridayPalette {
    static let shared = FridayPalette()
    var appearance = FridayAppearance(rawValue: UserDefaults.standard.string(forKey: FridayPreferenceKeys.appearance) ?? "") ?? .system
}

extension FridayTheme {
    static var isMidnight: Bool { FridayPalette.shared.appearance == .midnight }
    static func color(_ rgb: UInt32) -> Color {
        Color(.sRGB, red: Double(rgb >> 16 & 255) / 255, green: Double(rgb >> 8 & 255) / 255, blue: Double(rgb & 255) / 255, opacity: 1)
    }
    static func nativeColor(_ rgb: UInt32) -> FridayNativeColor {
        FridayNativeColor(red: CGFloat(rgb >> 16 & 255) / 255, green: CGFloat(rgb >> 8 & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
    }
    static func adaptiveNative(light: UInt32, dark: UInt32, midnight: UInt32? = nil) -> FridayNativeColor {
        let appearance = FridayPalette.shared.appearance
        if appearance == .midnight { return nativeColor(midnight ?? dark) }
        if appearance == .light { return nativeColor(light) }
        if appearance == .dark { return nativeColor(dark) }
        #if os(macOS)
        return NSColor(name: nil) { appearance in
            nativeColor(appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light)
        }
        #else
        return UIColor { traits in nativeColor(traits.userInterfaceStyle == .dark ? dark : light) }
        #endif
    }
    static func adaptive(light: UInt32, dark: UInt32, midnight: UInt32? = nil) -> Color {
        #if os(macOS)
        Color(nsColor: adaptiveNative(light: light, dark: dark, midnight: midnight))
        #else
        Color(uiColor: adaptiveNative(light: light, dark: dark, midnight: midnight))
        #endif
    }
    static var nativeForeground: FridayNativeColor { adaptiveNative(light: 0x1a1a1e, dark: 0xfafafa, midnight: 0xd1d4de) }
    static var nativeSecondaryText: FridayNativeColor { adaptiveNative(light: 0x71717a, dark: 0xa1a1aa, midnight: 0x9a9db0) }
    static var foreground: Color { adaptive(light: 0x1a1a1e, dark: 0xfafafa, midnight: 0xd1d4de) }
    static var secondaryText: Color { adaptive(light: 0x71717a, dark: 0xa1a1aa, midnight: 0x9a9db0) }
    static var sidebarBackground: Color { isMidnight ? color(0x121420) : canvas }
    static var separator: Color { adaptive(light: 0xe4e4e7, dark: 0x303036, midnight: 0x242636) }
    static var nativeLink: FridayNativeColor { isMidnight ? nativeColor(0x7eaaeb) : nativeColor(0x3563f4) }
    static var link: Color { isMidnight ? color(0x7eaaeb) : conversationUserBackground }
    static var interfaceFont: Font { .system(size: 14, weight: .regular) }
}
