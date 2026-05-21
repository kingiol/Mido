// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "MidoClient",
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
      name: "MidoClient"
    ),
    .testTarget(
      name: "MidoClientTests",
      dependencies: ["MidoClient"]
    )
  ],
  swiftLanguageModes: [.v6]
)
