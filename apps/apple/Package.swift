// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Friday",
    defaultLocalization: "zh-Hans",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "FridayKit", targets: ["FridayKit"]), .executable(name: "Friday", targets: ["FridayMac"]), .executable(name: "FridayService", targets: ["FridayService"])],
    dependencies: [.package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0")],
    targets: [
        .target(name: "FridayKit", resources: [.process("Resources")]),
        .executableTarget(name: "FridayMac", dependencies: ["FridayKit", .product(name: "Sparkle", package: "Sparkle", condition: .when(platforms: [.macOS]))], linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
        .executableTarget(name: "FridayService")
    ]
)
