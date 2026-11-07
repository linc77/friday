import SwiftUI
import FridayKit

@main
struct FridayApp: App {
    @UIApplicationDelegateAdaptor(FridayPhoneDelegate.self) private var delegate
    var body: some Scene {
        WindowGroup { FridayRootView() }
    }
}
