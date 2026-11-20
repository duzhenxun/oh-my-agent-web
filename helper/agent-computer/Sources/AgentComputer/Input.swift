import AppKit
import ApplicationServices

/// 键盘与剪贴板。
///
/// 快捷键走**真实修饰键事件**（先按下 cmd，再按主键，再抬起），而不是只设 flags：
/// 一部分应用（游戏、远程桌面、部分 Electron 应用）只认真实的修饰键序列。
enum Input {
	// MARK: - 组合键

	struct Combo {
		var flags: CGEventFlags = []
		/// 需要真正按下的修饰键（keyCode）
		var modifierKeyCodes: [CGKeyCode] = []
		var keyCode: CGKeyCode = 0
	}

	private static let modifierNames: [String: (CGEventFlags, CGKeyCode)] = [
		"cmd": (.maskCommand, 55),
		"command": (.maskCommand, 55),
		"⌘": (.maskCommand, 55),
		"shift": (.maskShift, 56),
		"⇧": (.maskShift, 56),
		"opt": (.maskAlternate, 58),
		"option": (.maskAlternate, 58),
		"alt": (.maskAlternate, 58),
		"⌥": (.maskAlternate, 58),
		"ctrl": (.maskControl, 59),
		"control": (.maskControl, 59),
		"⌃": (.maskControl, 59),
		"fn": (.maskSecondaryFn, 63),
	]

	private static let keyCodes: [String: CGKeyCode] = [
		"return": 36, "enter": 36, "⏎": 36,
		"tab": 48, "space": 49, "空格": 49,
		"delete": 51, "backspace": 51, "退格": 51,
		"escape": 53, "esc": 53,
		"forwarddelete": 117, "del": 117,
		"home": 115, "end": 119,
		"pageup": 116, "pagedown": 121,
		"left": 123, "right": 124, "down": 125, "up": 126,
		"←": 123, "→": 124, "↓": 125, "↑": 126,
		"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
		"f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
	]

	/// 字母/数字/符号的 ANSI 键码（US 布局；非美式布局下字符可能不同，但快捷键位置一致）
	private static let characterCodes: [Character: CGKeyCode] = [
		"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
		"b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
		"1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
		"-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
		"l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
		"m": 46, ".": 47, "`": 50,
	]

	/// 解析 `cmd+shift+s`、`Return`、`ctrl+alt+delete`
	static func parse(_ text: String) -> Combo? {
		let tokens = text
			.replacingOccurrences(of: "＋", with: "+")
			.split(separator: "+")
			.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
			.filter { !$0.isEmpty }
		guard !tokens.isEmpty else { return nil }

		var combo = Combo()
		for token in tokens.dropLast() {
			guard let modifier = modifierNames[token] else { return nil }
			combo.flags.insert(modifier.0)
			combo.modifierKeyCodes.append(modifier.1)
		}
		let last = tokens[tokens.count - 1]
		if let named = keyCodes[last] {
			combo.keyCode = named
			return combo
		}
		if last.count == 1, let code = characterCodes[Character(last)] {
			combo.keyCode = code
			return combo
		}
		return nil
	}

	static func sendKeys(_ text: String) throws -> [String: Any] {
		guard let combo = parse(text) else {
			throw HelperError(
				"badArguments",
				"看不懂这个组合键「\(text)」：写成 cmd+shift+s、Return、ctrl+alt+delete 这种形式",
				retryable: false
			)
		}
		for code in combo.modifierKeyCodes {
			post(code: code, flags: combo.flags, down: true)
			usleep(8_000)
		}
		post(code: combo.keyCode, flags: combo.flags, down: true)
		usleep(18_000)
		post(code: combo.keyCode, flags: combo.flags, down: false)
		for code in combo.modifierKeyCodes.reversed() {
			usleep(8_000)
			post(code: code, flags: combo.flags, down: false)
		}
		return ["ok": true, "key": text]
	}

	private static func post(code: CGKeyCode, flags: CGEventFlags, down: Bool) {
		let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
		event?.flags = flags
		event?.post(tap: .cghidEventTap)
	}

	// MARK: - 剪贴板粘贴

	/// 用剪贴板粘贴长文本：比逐字合成快得多，中文/emoji 也不会掉字。
	/// 结束后恢复用户原来的剪贴板内容。
	static func paste(_ text: String, format: String?) throws -> [String: Any] {
		let pasteboard = NSPasteboard.general
		let saved = pasteboard.pasteboardItems?.map { item -> [NSPasteboard.PasteboardType: Data] in
			var copy: [NSPasteboard.PasteboardType: Data] = [:]
			for type in item.types {
				if let data = item.data(forType: type) { copy[type] = data }
			}
			return copy
		} ?? []

		pasteboard.clearContents()
		switch (format ?? "text").lowercased() {
		case "markdown", "html":
			pasteboard.setString(text, forType: .html)
			pasteboard.setString(text, forType: .string)
		default:
			pasteboard.setString(text, forType: .string)
		}

		do {
			_ = try sendKeys("cmd+v")
		} catch {
			restore(pasteboard, saved)
			throw error
		}
		// 粘贴是异步的：给目标 App 一点时间读完再恢复剪贴板
		usleep(350_000)
		restore(pasteboard, saved)
		return ["ok": true, "how": "paste", "characters": text.count]
	}

	private static func restore(_ pasteboard: NSPasteboard, _ saved: [[NSPasteboard.PasteboardType: Data]]) {
		pasteboard.clearContents()
		guard !saved.isEmpty else { return }
		let items: [NSPasteboardItem] = saved.map { entry in
			let item = NSPasteboardItem()
			for (type, data) in entry { item.setData(data, forType: type) }
			return item
		}
		pasteboard.writeObjects(items)
	}
}
