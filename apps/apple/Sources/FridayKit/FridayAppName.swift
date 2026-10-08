import Foundation

public enum FridayAppName {
    public static var displayName: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Friday"
    }
}
