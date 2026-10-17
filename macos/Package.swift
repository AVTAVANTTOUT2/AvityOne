// swift-tools-version: 5.10
// AvityOne for macOS: native SwiftUI client driving the embedded AvityOne engine (src/, Node 24).
import PackageDescription

let package = Package(
  name: "AvityOne",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "AvityOne", targets: ["AvityOne"]),
    .library(name: "AvityKit", targets: ["AvityKit"]),
  ],
  dependencies: [
    // UI only, as package.json devDependencies: the engine itself stays dependency-free.
    .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.20.0"),
    .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", exact: "2.4.1"),
  ],
  targets: [
    .target(name: "AvityKit"),
    .executableTarget(
      name: "AvityOne",
      dependencies: [
        "AvityKit",
        .product(name: "SwiftTerm", package: "SwiftTerm"),
        .product(name: "MarkdownUI", package: "swift-markdown-ui"),
      ]
    ),
    // `pdftotext -layout <file> -` for the engine's document import, built on PDFKit (no Poppler on a stock Mac).
    .executableTarget(name: "pdftotext"),
    .testTarget(name: "AvityKitTests", dependencies: ["AvityKit"]),
  ]
)
