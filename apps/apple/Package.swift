// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Friday",
    defaultLocalization: "zh-Hans",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "FridayKit", targets: ["FridayKit"]), .executable(name: "Friday", targets: ["FridayMac"])],
    targets: [
        .target(name: "FridayKit", resources: [.process("Resources")]),
        .executableTarget(name: "FridayMac", dependencies: ["FridayKit"])
    ]
)
