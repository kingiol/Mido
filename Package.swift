// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "Mido",
  platforms: [
    .iOS(.v15),
    .macOS(.v13)
  ],
  products: [
    .library(
      name: "MidoClient",
      targets: ["MidoClient"]
    )
  ],
  targets: [
    .target(
      name: "MidoClient",
      path: "packages/client-ios/Sources/MidoClient"
    ),
    .testTarget(
      name: "MidoClientTests",
      dependencies: ["MidoClient"],
      path: "packages/client-ios/Tests/MidoClientTests"
    )
  ],
  swiftLanguageModes: [.v6]
)
