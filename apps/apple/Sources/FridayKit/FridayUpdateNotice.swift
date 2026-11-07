#if os(macOS)
import SwiftUI

/// The macOS updater owns discovery and skip persistence; the rail only presents it.
@MainActor
public final class FridayUpdateNotice: ObservableObject {
    public static let shared = FridayUpdateNotice()
    @Published public private(set) var version: String?
    private var open: (() -> Void)?

    public func present(version: String, open: @escaping () -> Void) {
        self.open = open
        self.version = version
    }

    public func clear() {
        version = nil
        open = nil
    }

    public func show() { open?() }
}

struct FridayUpdateNoticeButton: View {
    @ObservedObject private var notice = FridayUpdateNotice.shared

    var body: some View {
        if let version = notice.version {
            Button { notice.show() } label: {
                FridaySymbolImage(systemName: "arrow.up.circle")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(FridayTheme.accent)
                    .frame(width: 36, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(FridaySymbolButtonStyle())
            .help(Text(friday: "升级"))
            .accessibilityLabel(Text(friday: "升级"))
            .accessibilityValue(Text(verbatim: version))
        }
    }
}
#endif
