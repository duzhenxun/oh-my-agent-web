import Foundation

/// helper 自己的设置，来自 helper 的 `settings.json`（与 oh-my-agent-web 的
/// `server/computer/settings.ts` 写的是同一份文件）。
///
/// 重点：**每次用到时都重新读**（带 2 秒缓存）。
/// 面板里刚勾上「显示实时预览浮窗」，下一次 observe 就该生效，不需要重启 helper。
struct HelperSettings {
	var previewEnabled = true
	/// watermark.enabled：操作时屏幕边缘的水印（默认开）
	var watermarkEnabled = true
	/// 浮窗大小：small / medium / large（双击浮窗切换）
	var previewSize = "small"
	/// 用户拖动后的位置（AppKit 全局坐标，左下原点）；nil = 默认右下角
	var previewX: Double?
	var previewY: Double?
	var pointerEnabled = true
	var pointerSpeed = 1.0
	var keyDelayMs = 12
	var activateTarget = false
	var borrowFront = true

	private static var cache: (at: Date, value: HelperSettings)?
	private static let lock = NSLock()

	static var current: HelperSettings {
		lock.lock()
		defer { lock.unlock() }
		if let cache, Date().timeIntervalSince(cache.at) < 2 { return cache.value }
		let value = load()
		cache = (Date(), value)
		return value
	}

	/// 设置文件被面板改过之后，强制重新读一次
	static func invalidate() {
		lock.lock()
		defer { lock.unlock() }
		cache = nil
	}

	private static func load() -> HelperSettings {
		var settings = HelperSettings()
		let home = FileManager.default.homeDirectoryForCurrentUser
		let file = home.appendingPathComponent("Library/Application Support/AgentComputer/settings.json")
		guard let data = try? Data(contentsOf: file),
			let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
			return settings
		}
		func section(_ name: String) -> [String: Any] {
			root[name] as? [String: Any] ?? [:]
		}
		func bool(_ object: [String: Any], _ key: String, _ fallback: Bool) -> Bool {
			object[key] as? Bool ?? fallback
		}
		func number(_ object: [String: Any], _ key: String, _ fallback: Double) -> Double {
			(object[key] as? NSNumber)?.doubleValue ?? fallback
		}

		let preview = section("preview")
		let pointer = section("pointer")
		let typing = section("typing")
		let focus = section("focus")

		settings.previewEnabled = bool(preview, "enabled", true)
		settings.watermarkEnabled = bool(section("watermark"), "enabled", true)
		let size = preview["size"] as? String ?? "small"
		settings.previewSize = ["small", "medium", "large"].contains(size) ? size : "small"
		settings.previewX = (preview["x"] as? NSNumber)?.doubleValue
		settings.previewY = (preview["y"] as? NSNumber)?.doubleValue
		settings.pointerEnabled = bool(pointer, "enabled", true)
		// 与面板的范围保持一致：0.25–4
		settings.pointerSpeed = min(4, max(0.25, number(pointer, "speed", 1)))
		// 0–200 毫秒
		settings.keyDelayMs = Int(min(200, max(0, number(typing, "keyDelayMs", 12))))
		settings.activateTarget = bool(focus, "activateTarget", false)
		settings.borrowFront = bool(focus, "borrowFront", true)
		return settings
	}
}
