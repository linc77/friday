// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Friday",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "FridayKit", targets: ["FridayKit"]), .executable(name: "Friday", targets: ["FridayMac"])],
    targets: [
        .target(name: "FridayKit"),
        .executableTarget(name: "FridayMac", dependencies: ["FridayKit"])
    ]
)
