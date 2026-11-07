// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Friday",
    defaultLocalization: "zh-Hans",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "FridayKit", targets: ["FridayKit"]), .executable(name: "Friday", targets: ["FridayMac"]), .executable(name: "FridayService", targets: ["FridayService"])],
    dependencies: [.package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0"), .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.20.0"), .package(url: "https://github.com/swiftlang/swift-markdown", exact: "0.9.0")],
    targets: [
        .target(name: "FridayKit", dependencies: [.product(name: "SwiftTerm", package: "SwiftTerm"), .product(name: "Markdown", package: "swift-markdown")], resources: [.process("Resources")]),
        .testTarget(name: "MarkdownRenderingTests", dependencies: ["FridayKit"], path: "Tests/MarkdownRenderingTests"),
        .executableTarget(name: "FridayMac", dependencies: ["FridayKit", .product(name: "Sparkle", package: "Sparkle", condition: .when(platforms: [.macOS]))], linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
        .executableTarget(name: "FridayService")
    ]
)
