import Foundation

/// helper 返回的错误名，与 oh-my-agent-web 的 `HelperError.errorName` 对应。
/// `retryable` 决定 agent 能不能自动重试：操作类错误一律 false（可能已经点过了）。
struct HelperError: Error {
	let name: String
	let message: String
	let retryable: Bool

	init(_ name: String, _ message: String, retryable: Bool = false) {
		self.name = name
		self.message = message
		self.retryable = retryable
	}

	/// 转成客户端认识的 JSON-RPC error（`data.name` / `data.retryable`）。
	func asJSON(id: Any?) -> [String: Any] {
		[
			"jsonrpc": "2.0",
			"id": id ?? NSNull(),
			"error": [
				"code": code,
				"message": message,
				"data": ["name": name, "retryable": retryable],
			],
		]
	}

	/// 错误码只需要稳定，客户端不依赖具体数值（只用 data.name）。
	private var code: Int {
		switch name {
		case "badArguments": return -32602
		case "noSuchMethod": return -32601
		case "accessMissing": return 4010
		case "appMissing": return 4013
		case "notSupported": return 4014
		case "timedOut": return 4015
		default: return -32603
		}
	}
}

enum Log {
	static let path = FileManager.default.homeDirectoryForCurrentUser
		.appendingPathComponent("Library/Application Support/AgentComputer/helper.log")

	static func write(_ message: String) {
		let stamp = ISO8601DateFormatter().string(from: Date())
		let line = "[\(stamp)] \(message)\n"
		FileHandle.standardError.write(Data(line.utf8))
		guard let data = line.data(using: .utf8) else { return }
		try? FileManager.default.createDirectory(
			at: path.deletingLastPathComponent(),
			withIntermediateDirectories: true
		)
		if let handle = try? FileHandle(forWritingTo: path) {
			handle.seekToEndOfFile()
			handle.write(data)
			try? handle.close()
		} else {
			try? data.write(to: path)
		}
	}
}

/// 一次性迁移：把旧名字的数据目录搬到新名字下。
///
/// 数据目录里有设置、解除保护名单、截图；改名后如果直接换路径，
/// 用户会突然"所有设置都回到默认"，所以启动时先尝试搬一次。
enum LegacyMigration {
	static func run() {
		let fm = FileManager.default
		let home = fm.homeDirectoryForCurrentUser
		let target = home.appendingPathComponent("Library/Application Support/AgentComputer")
		guard !fm.fileExists(atPath: target.path) else { return }
		for legacy in ["ComputerUseTurbo", "AgentComputerUse", "AgentComputerUseTurbo", "ComputerUse"] {
			let old = home.appendingPathComponent("Library/Application Support/\(legacy)")
			guard fm.fileExists(atPath: old.path) else { continue }
			do {
				try fm.moveItem(at: old, to: target)
				Log.write("已迁移旧数据目录：\(legacy) → AgentComputer")
			} catch {
				Log.write("迁移旧数据目录失败（\(legacy)）：\(error.localizedDescription)")
			}
			return
		}
	}
}
