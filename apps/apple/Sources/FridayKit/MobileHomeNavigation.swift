#if os(iOS)
import SwiftUI

extension View {
    func fridayMobileHomeNavigation() -> some View {
        toolbar(.visible, for: .tabBar)
    }
}
#endif
