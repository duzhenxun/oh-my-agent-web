import AppKit
import ApplicationServices

/// 界面快照：一次 observe 得到的「编号元素树」。
///
/// 编号只对最近一次快照有效 —— agent 拿着旧编号去点，可能点到完全不同的东西，
/// 所以每次 observe 都会重建注册表，并按 generation 计数。
final class Snapshot {
	static let maxElements = 900
	static let maxDepth = 40

	/// 每次 observe 自增：截图文件名用它，agent 也能看出快照新旧
	let generation: Int
	/// 编号 → 元素（供 act 用）
	private(set) var elements: [Int: AXUIElement] = [:]
	/// 已经展开过的元素（无障碍树里同一元素可能被多个父引用，避免无限递归）
	private var visited = Set<ObjectIdentifier>()
	/// 被快照的窗口在屏幕上的位置与尺寸（坐标点击换算用）
	private(set) var windowOrigin: CGPoint = .zero
	private(set) var windowSize: CGSize = .zero
	private(set) var windowNumber: CGWindowID = 0
	/// 截图缩放：Retina 截图像素 ÷ 逻辑像素。坐标点击要用它换算
	private(set) var scale: CGFloat = 1

	private static let generator = Counter()

	init() {
		generation = Snapshot.generator.next()
	}

	/// 按截图宽度校准缩放（截图比窗口宽 2 倍 = Retina）
	func calibrateScale(imageWidth: Int) {
		guard windowSize.width > 0, imageWidth > 0 else { return }
		scale = CGFloat(imageWidth) / windowSize.width
	}

	private(set) var lines: [String] = []
	private var truncated = false

	static func capture(_ target: TargetApp, fullTree: Bool, preferredWindow: String? = nil) throws -> Snapshot {
		let snapshot = Snapshot()
		let windows = Snapshot.attribute(target.element, kAXWindowsAttribute) as? [AXUIElement] ?? []
		let window = Snapshot.pickWindow(target: target, windows: windows, preferred: preferredWindow)
		if let position = Snapshot.point(window, kAXPositionAttribute),
			let size = Snapshot.size(window, kAXSizeAttribute) {
			snapshot.windowOrigin = position
			snapshot.windowSize = size
			snapshot.windowNumber = WindowNumber.of(window) ?? 0
			let title = Snapshot.string(window, kAXTitleAttribute) ?? target.name
			snapshot.lines.append(
				"#0 window \"\(title)\" (\(Int(size.width))×\(Int(size.height)) @ \(Int(position.x)),\(Int(position.y)))"
			)
		}

		let limit = fullTree ? Snapshot.maxElements * 2 : Snapshot.maxElements
		let depth = fullTree ? Snapshot.maxDepth : 18
		snapshot.walk(window, depth: 0, maxDepth: depth, limit: limit, indent: 0)

		// 多窗口时把标题列出来：agent 才有机会用 window 参数换一个
		if windows.count > 1 {
			let titles = windows.compactMap { Snapshot.string($0, kAXTitleAttribute) }.filter { !$0.isEmpty }
			if !titles.isEmpty {
				snapshot.lines.append("其他窗口：" + titles.prefix(6).joined(separator: "、"))
			}
		}
		if snapshot.truncated {
			snapshot.lines.append("……界面元素太多，已截断（可用 observe --full 取更多）")
		}
		return snapshot
	}

	/// 选窗口：聚焦窗口 → 主窗口 → 标准窗口 → 第一个。
	///
	/// 顺序很重要：App 可能同时挂着提示浮窗（Caps Lock 提示、更新提醒），
	/// 它们也是 AXWindow，直接取第一个会一直操作那个浮窗，而真正的内容窗口在它后面。
	static func pickWindow(target: TargetApp, windows: [AXUIElement], preferred: String? = nil) -> AXUIElement {
		// 先把「桌面/跨屏覆盖层」排除掉：Finder 的窗口列表里常有一个覆盖所有屏幕的窗口，
		// 选中它会得到整屏截图 + 一堆无意义的元素，看起来像「截到了但没截对」。
		let screens = NSScreen.screens
		let union = screens.dropFirst().reduce(screens.first?.frame ?? .zero) { $0.union($1.frame) }
		func looksLikeDesktop(_ window: AXUIElement) -> Bool {
			guard let size = Snapshot.size(window, kAXSizeAttribute) else { return false }
			return size.width >= union.width - 24 && size.height >= union.height - 24
		}
		let usable = windows.filter { !looksLikeDesktop($0) }
		if ProcessInfo.processInfo.environment["DEBUG_WINDOWS"] == "1" {
			let list = windows.map { window -> String in
				let size = Snapshot.size(window, kAXSizeAttribute) ?? .zero
				let title = Snapshot.string(window, kAXTitleAttribute) ?? ""
				return "\(Int(size.width))x\(Int(size.height))\"\(title)\""
			}
			Log.write("pickWindow union=\(Int(union.width))x\(Int(union.height)) candidates=[\(list.joined(separator: ", "))] usable=\(usable.count)")
		}
		let pool = usable.isEmpty ? windows : usable

		if let preferred, !preferred.isEmpty {
			let matched = pool.first { window in
				let title = Snapshot.string(window, kAXTitleAttribute) ?? ""
				return title.localizedCaseInsensitiveContains(preferred)
			}
			if let matched { return matched }
		}
		if let focused = Snapshot.attribute(target.element, kAXFocusedWindowAttribute),
			CFGetTypeID(focused) == AXUIElementGetTypeID(),
			!looksLikeDesktop(focused as! AXUIElement) {
			return focused as! AXUIElement
		}
		if let main = Snapshot.attribute(target.element, kAXMainWindowAttribute),
			CFGetTypeID(main) == AXUIElementGetTypeID(),
			!looksLikeDesktop(main as! AXUIElement) {
			return main as! AXUIElement
		}
		let standard = pool.first {
			Snapshot.string($0, kAXSubroleAttribute) == (kAXStandardWindowSubrole as String)
		}
		return standard ?? pool.first ?? target.element
	}

	/// 深度优先展开，给每个可交互元素编号
	private func walk(_ element: AXUIElement, depth: Int, maxDepth: Int, limit: Int, indent: Int) {
		guard elements.count < limit else {
			truncated = true
			return
		}
		guard depth <= maxDepth else {
			truncated = true
			return
		}
		guard visited.insert(ObjectIdentifier(element)).inserted else { return }
		let line = Snapshot.describe(element, number: elements.count + 1, indent: indent)
		if let line {
			let number = elements.count + 1
			elements[number] = element
			lines.append(line)
		}

		guard let children = Snapshot.attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return }
		for child in children {
			walk(child, depth: depth + 1, maxDepth: maxDepth, limit: limit, indent: line == nil ? indent : indent + 1)
		}
	}

	/// 渲染成一行 `#12 button "保存" (x,y,w,h) enabled=false`
	private static func describe(_ element: AXUIElement, number: Int, indent: Int) -> String? {
		let role = string(element, kAXRoleAttribute)
		let title = string(element, kAXTitleAttribute).map { clean($0, limit: 80) }
		let description = string(element, kAXDescriptionAttribute).map { clean($0, limit: 80) }
		// 值里可能带换行：不转义会把「一行一个元素」的格式撑断，agent 就解析错了
		let value = string(element, kAXValueAttribute).map { clean($0, limit: 120) }
		let identifier = string(element, kAXIdentifierAttribute)
		let placeholder = string(element, kAXPlaceholderValueAttribute).map { clean($0, limit: 60) }
		let enabled = Snapshot.attribute(element, kAXEnabledAttribute) as? Bool
		let focused = Snapshot.attribute(element, kAXFocusedAttribute) as? Bool

		// 什么都没有的容器元素对 agent 没意义，跳过但保留子节点
		let meaningful = [role, title, description, value, identifier, placeholder].contains { ($0 ?? "").isEmpty == false }
		guard meaningful else { return nil }

		var parts: [String] = ["\(String(repeating: "  ", count: max(0, indent)))#\(number) \(role ?? "element")"]
		if let title, !title.isEmpty { parts.append("\"\(title)\"") }
		if let identifier, !identifier.isEmpty, identifier != title { parts.append("id=\(identifier)") }
		if let placeholder, !placeholder.isEmpty { parts.append("placeholder=\"\(placeholder)\"") }
		if let description, !description.isEmpty, description != title { parts.append("desc=\"\(description)\"") }
		if let value, !value.isEmpty, value != title { parts.append("value=\"\(value)\"") }
		if enabled == false { parts.append("enabled=false") }
		if focused == true { parts.append("focused") }
		if let position = point(element, kAXPositionAttribute), let size = size(element, kAXSizeAttribute) {
			parts.append("(\(Int(position.x)),\(Int(position.y)),\(Int(size.width)),\(Int(size.height)))")
		}
		return parts.joined(separator: " ")
	}

}

/// 快照序号
private final class Counter {
	private var value = 0
	private let lock = NSLock()

	func next() -> Int {
		lock.lock()
		defer { lock.unlock() }
		value += 1
		return value
	}
}

extension Snapshot {
	/// 转义成单行文本：换行/制表符/引号都在这里处理掉
	private static func clean(_ text: String, limit: Int) -> String {
		let escaped = text
			.replacingOccurrences(of: "\\", with: "\\\\")
			.replacingOccurrences(of: "\n", with: "\\n")
			.replacingOccurrences(of: "\r", with: "\\r")
			.replacingOccurrences(of: "\t", with: "\\t")
			.replacingOccurrences(of: "\"", with: "'")
		return escaped.count > limit ? String(escaped.prefix(limit)) + "…" : escaped
	}

	// MARK: - 属性取值

	static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
		return value
	}

	static func string(_ element: AXUIElement, _ name: String) -> String? {
		guard let value = attribute(element, name) else { return nil }
		if let text = value as? String { return text }
		if let number = value as? NSNumber { return number.stringValue }
		return nil
	}

	static func int(_ element: AXUIElement, _ name: String) -> Int? {
		(attribute(element, name) as? NSNumber)?.intValue
	}

	static func point(_ element: AXUIElement, _ name: String) -> CGPoint? {
		guard let raw = attribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
		var value = CGPoint.zero
		return AXValueGetValue(raw as! AXValue, .cgPoint, &value) ? value : nil
	}

	static func size(_ element: AXUIElement, _ name: String) -> CGSize? {
		guard let raw = attribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
		var value = CGSize.zero
		return AXValueGetValue(raw as! AXValue, .cgSize, &value) ? value : nil
	}
}
