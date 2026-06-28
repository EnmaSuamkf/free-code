// swift-tools-version: 5.9
import PackageDescription

let package = Package(
	name: "FreeCodeMac",
	platforms: [.macOS(.v13)],
	products: [
		.executable(name: "FreeCodeMac", targets: ["FreeCodeMac"]),
	],
	dependencies: [],
	targets: [
		.executableTarget(
			name: "FreeCodeMac",
			path: "Sources/FreeCodeMac",
			resources: [
				.copy("Media"),
				.copy("HostSrc"),
			],
		),
	],
)
