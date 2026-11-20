import AppKit
import ApplicationServices

/// 菜单：枚举整棵菜单树、按路径执行命令。
///
/// 菜单是「任何软件都通用」的操作通道 —— 自绘界面拿不到按钮编号时，菜单项几乎总能拿到。
enum Menu {
	struct Item {
		let path: [String]
		let element: AXUIElement
		let shortcut: String?
	}

	/// 这些子树是动态列表（几百个最近文件），不是「能执行的命令」，展开只会淹没有用信息
	private static let skipSubtrees: Set<String> = [
		"最近使用的项目", "最近打开", "最近使用", "打开最近使用",
		"recent items", "recent documents", "recent places", "open recent",
		"服务", "services", "共享", "share",
	]

	/// 单个父菜单最多展开多少项（苹果菜单里也有很长的列表）
	private static let maxPerParent = 40

	/// 遍历 app 的菜单栏，收集所有叶子命令
	static func all(_ target: TargetApp, limit: Int = 600) -> [Item] {
		guard let bar = Snapshot.attribute(target.element, kAXMenuBarAttribute) else { return [] }
		var items: [Item] = []

		func walk(_ element: AXUIElement, path: [String], depth: Int) {
			guard items.count < limit, depth < 8 else { return }
			guard let children = Snapshot.attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return }
			for child in children.prefix(maxPerParent) {
				let title = Snapshot.string(child, kAXTitleAttribute) ?? ""
				if skipSubtrees.contains(title.lowercased()) { continue }
				let role = Snapshot.string(child, kAXRoleAttribute) ?? ""
				let nextPath = title.isEmpty ? path : path + [title]
				if role == (kAXMenuItemRole as String) {
					if !title.isEmpty {
						items.append(Item(path: path + [title], element: child, shortcut: shortcutOf(child)))
					}
					// 菜单项自己也可能挂着子菜单（格式 ▸ 字体 ▸ 粗体），必须继续往下钻
					walk(child, path: nextPath, depth: depth + 1)
					continue
				}
				walk(child, path: nextPath, depth: depth + 1)
			}
		}

		walk(bar as! AXUIElement, path: [], depth: 0)
		return items
	}

	/// 只返回命令（去掉纯分隔/空标题），给 appCommands 用
	static func commands(_ target: TargetApp) -> [String: Any] {
		let list = all(target).map { item -> [String: Any] in
			var entry: [String: Any] = ["path": item.path, "title": item.path.last ?? ""]
			if let shortcut = item.shortcut { entry["shortcut"] = shortcut }
			return entry
		}
		return ["commands": list, "count": list.count]
	}

	static func shortcutOf(_ element: AXUIElement) -> String? {
		let char = Snapshot.string(element, "AXMenuItemCmdChar") ?? ""
		let glyph = (Snapshot.attribute(element, "AXMenuItemCmdGlyph") as? NSNumber)?.intValue ?? 0
		let modifiers = (Snapshot.attribute(element, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0
		// 0 = 有 cmd；1 = 无 cmd（只要 shift 等）
		var parts: [String] = []
		if modifiers & 0b0010 != 0 { parts.append("shift") }
		if modifiers & 0b0100 != 0 { parts.append("opt") }
		if modifiers & 0b1000 != 0 { parts.append("ctrl") }
		if modifiers & 0b0001 == 0 { parts.insert("cmd", at: 0) }
		let key = specialKey(glyph) ?? char
		// 没有真实按键字符时不要编造「cmd」这种假快捷键
		guard !key.isEmpty else { return nil }
		parts.append(key)
		return parts.joined(separator: "+")
	}

	private static func specialKey(_ glyph: Int) -> String? {
		switch glyph {
		case 0x21: return "pageup"
		case 0x22: return "pagedown"
		case 0x23: return "end"
		case 0x24: return "return"
		case 0x25: return "left"
		case 0x26: return "up"
		case 0x27: return "right"
		case 0x28: return "down"
		case 0x29: return "tab"
		case 0x2A: return "backspace"
		case 0x2B: return "escape"
		case 0x2C: return "space"
		case 0x2D: return "delete"
		case 0x73: return "home"
		default: return nil
		}
	}

	/// 按路径执行：`["文件", "存储"]` 或 `["File", "Save"]`
	static func run(_ target: TargetApp, path: [String]) throws -> [String: Any] {
		guard path.count >= 1 else {
			throw HelperError("badArguments", "菜单路径不能为空", retryable: false)
		}
		AgentHUD.begin(app: target.name, action: "菜单 \(path.joined(separator: " ▸ "))")
		// 菜单栏只在应用是前台时可用
		target.app.activate(options: [.activateIgnoringOtherApps])
		usleep(180_000)

		let all = Menu.all(target, limit: 2_000)
		let matched = all.filter { $0.path.count == path.count && zip($0.path, path).allSatisfy { $0.caseInsensitiveCompare($1) == .orderedSame } }
		guard let item = matched.first else {
			let near = all.filter { $0.path.last?.caseInsensitiveCompare(path.last ?? "") == .orderedSame }.prefix(3)
			let hint = near.isEmpty ? "" : "；相似的命令：" + near.map { $0.path.joined(separator: " ▸ ") }.joined(separator: "、")
			throw HelperError("appMissing", "没有这条菜单命令：「\(path.joined(separator: " ▸ "))」\(hint)", retryable: false)
		}
		guard AXUIElementPerformAction(item.element, kAXPressAction as CFString) == .success else {
			throw HelperError("notSupported", "这条命令此刻不能执行（可能是灰的）：「\(path.joined(separator: " ▸ "))」", retryable: true)
		}
		usleep(120_000)
		return ["ok": true, "path": path]
	}
}
