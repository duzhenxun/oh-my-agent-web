// swift-tools-version:6.0
import PackageDescription

// 最小可用的 Agent Computer 兼容 helper。
// 打包成 .app 由 scripts/build-app.sh 负责（SwiftPM 只产出可执行文件）。
let package = Package(
	name: "AgentComputer",
	platforms: [.macOS(.v13)],
	targets: [
		.executableTarget(
			name: "AgentComputer",
			path: "Sources/AgentComputer",
			swiftSettings: [.swiftLanguageMode(.v5)]
		)
	]
)
