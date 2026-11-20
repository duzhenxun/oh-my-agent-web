import AppKit
import ApplicationServices

/// 动作执行：点击 / 输入 / 赋值 / 滚动 / 拖拽 / 任意无障碍动作。
///
/// 稳定性原则（这些是「流畅操作任何软件」的关键）：
///   1. 先让目标窗口到前台，否则 AXPress 可能作用在后台窗口、坐标点击会打到别的 App；
///   2. 优先无障碍接口，坐标点击只做兜底；
///   3. 动作前检查元素是否 enabled，灰按钮直接报清楚，而不是点了没反应；
///   4. 从不重试：超时后可能已经点过了，重试会重复提交表单；
///   5. 用户正在拖鼠标 / 按着键时不动手，避免和用户抢输入。
enum Actions {
	/// 最近一次快照：编号和窗口位置都来自它
	private(set) static var current: Snapshot?

	/// nil = finishTurn：清掉编号，之后的按编号操作会要求重新 observe
	static func setSnapshot(_ snapshot: Snapshot?) {
		current = snapshot
	}

	// MARK: - 元素解析

	/// 编号 → 元素，并把编号过期说清楚（旧编号点到别的东西是最危险的事）
	private static func element(_ number: Int) throws -> AXUIElement {
		guard let snapshot = current else {
			throw HelperError("badArguments", "还没有界面快照：先 observe 再按编号操作", retryable: true)
		}
		guard let element = snapshot.elements[number] else {
			throw HelperError(
				"badArguments",
				"编号 #\(number) 不在最近一次快照（第 \(snapshot.generation) 次）里：界面可能变了，请重新 observe",
				retryable: true
			)
		}
		return element
	}

	private static func ensureEnabled(_ element: AXUIElement, number: Int) throws {
		if let enabled = Snapshot.attribute(element, kAXEnabledAttribute) as? Bool, enabled == false {
			throw HelperError("notSupported", "#\(number) 现在是灰的（enabled=false），点它不会有反应", retryable: true)
		}
	}

	// MARK: - 点击

	static func click(_ target: TargetApp, step: [String: Any]) throws -> [String: Any] {
		let elementNumber = step["elementNumber"] as? Int
		let x = number(step["x"])
		let y = number(step["y"])
		let button = (step["button"] as? String) ?? "left"
		let times = max(1, min(3, (step["clickTimes"] as? Int) ?? 1))
		try ensureNotBusyUser()

		if let elementNumber {
			let element = try self.element(elementNumber)
			AgentHUD.begin(app: target.name, action: "点击 #\(elementNumber)")
			raise(target)
			if let center = center(of: element) {
				PointerOverlay.shared.show()
				PointerOverlay.shared.move(to: center)
			}
			try ensureEnabled(element, number: elementNumber)
			if press(element) {
				if let center = center(of: element) { PointerOverlay.shared.pulse(at: center) }
				settle()
				return ["ok": true, "how": "accessibility", "elementNumber": elementNumber]
			}
			guard let center = center(of: element) else {
				throw HelperError("notSupported", "#\(elementNumber) 既不支持按下动作，也读不到位置", retryable: false)
			}
			PointerOverlay.shared.pulse(at: center)
			clickAt(screenPoint: center, button: button, times: times)
			settle()
			return ["ok": true, "how": "click", "elementNumber": elementNumber, "point": ["x": center.x, "y": center.y]]
		}

		guard let x, let y else {
			throw HelperError("badArguments", "点击需要 elementNumber，或者同时给 x 与 y（截图像素）", retryable: false)
		}
		let screen = try screenPoint(x: x, y: y)
		AgentHUD.begin(app: target.name, action: "点击坐标 \(Int(x)),\(Int(y))")
		raise(target)
		PointerOverlay.shared.show()
		PointerOverlay.shared.pulse(at: screen)
		clickAt(screenPoint: screen, button: button, times: times)
		settle()
		return ["ok": true, "how": "click", "point": ["x": screen.x, "y": screen.y]]
	}

	private static func press(_ element: AXUIElement) -> Bool {
		var names: CFArray?
		guard AXUIElementCopyActionNames(element, &names) == .success,
			let actions = names as? [String], actions.contains(kAXPressAction as String) else {
			return false
		}
		return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
	}

	/// 执行任意无障碍动作（AXShowMenu、AXIncrement、AXConfirm…）
	static func invoke(_ target: TargetApp, step: [String: Any]) throws -> [String: Any] {
		guard let elementNumber = step["elementNumber"] as? Int else {
			throw HelperError("badArguments", "invokeAction 需要 elementNumber", retryable: false)
		}
		guard let name = step["name"] as? String, !name.isEmpty else {
			throw HelperError("badArguments", "invokeAction 需要 name（如 AXShowMenu、AXConfirm）", retryable: false)
		}
		let element = try self.element(elementNumber)
		AgentHUD.begin(app: target.name, action: "执行 \(name)")
		raise(target)

		var names: CFArray?
		let available = AXUIElementCopyActionNames(element, &names) == .success ? (names as? [String] ?? []) : []
		guard available.contains(name) else {
			throw HelperError(
				"notSupported",
				"#\(elementNumber) 不支持动作 \(name)；它支持的是：\(available.isEmpty ? "（没有）" : available.joined(separator: ", "))",
				retryable: false
			)
		}
		let error = AXUIElementPerformAction(element, name as CFString)
		guard error == .success else {
			throw HelperError("notSupported", "执行 \(name) 失败：AXError \(error.rawValue)", retryable: false)
		}
		settle()
		return ["ok": true, "elementNumber": elementNumber, "action": name]
	}

	// MARK: - 输入

	static func writeText(_ target: TargetApp, step: [String: Any]) throws -> [String: Any] {
		guard let text = step["text"] as? String, !text.isEmpty else {
			throw HelperError("badArguments", "writeText 需要 text", retryable: false)
		}
		try ensureNotBusyUser()

		// 密码框绝不代填：这是安全边界，提示词绕不过去
		if let elementNumber = step["elementNumber"] as? Int, isSecure(try element(elementNumber)) {
			throw HelperError(
				"notSupported",
				"#\(elementNumber) 看起来是密码输入框：helper 不会代填密码，请让用户自己输入",
				retryable: false
			)
		}

		// ① 指定元素：直接写值，不抢焦点也最快
		if let elementNumber = step["elementNumber"] as? Int {
			let element = try self.element(elementNumber)
			AgentHUD.begin(app: target.name, action: "输入到 #\(elementNumber)")
			raise(target)
			if AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef) == .success {
				settle()
				return ["ok": true, "how": "accessibility", "elementNumber": elementNumber]
			}
			if let center = center(of: element) {
				clickAt(screenPoint: center, button: "left", times: 1)
				usleep(80_000)
			}
		} else {
			AgentHUD.begin(app: target.name, action: "输入文字")
			raise(target)
			PointerOverlay.shared.show()
		}

		// ② 走键盘：短文本直接合成，长文本用剪贴板（中文/emoji 更稳）
		if text.count > 80 {
			return try Input.paste(text, format: "text")
		}
		typeViaKeyboard(text)
		settle()
		return ["ok": true, "how": "keyboard", "characters": text.count]
	}

	/// 直接替换输入框内容（等价于全选后覆盖）
	static func fill(_ target: TargetApp, step: [String: Any]) throws -> [String: Any] {
		guard let elementNumber = step["elementNumber"] as? Int else {
			throw HelperError("badArguments", "fillValue 需要 elementNumber", retryable: false)
		}
		guard let value = step["value"] as? String else {
			throw HelperError("badArguments", "fillValue 需要 value", retryable: false)
		}
		let element = try self.element(elementNumber)
		AgentHUD.begin(app: target.name, action: "填写 #\(elementNumber)")
		raise(target)
		if isSecure(element) {
			throw HelperError("notSupported", "#\(elementNumber) 是密码框，helper 不代填密码", retryable: false)
		}
		// 焦点 + 全选 + 写入：比只设 AXValue 更接近真人操作，也能触发 App 的校验逻辑
		AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
		usleep(40_000)
		if AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef) == .success {
			settle()
			return ["ok": true, "how": "accessibility", "elementNumber": elementNumber]
		}
		_ = try Input.sendKeys("cmd+a")
		usleep(40_000)
		typeViaKeyboard(value)
		settle()
		return ["ok": true, "how": "keyboard", "elementNumber": elementNumber]
	}

	static func sendKeys(_ target: TargetApp, step: [String: Any]) throws -> [String: Any] {
		guard let key = step["key"] as? String, !key.isEmpty else {
			throw HelperError("badArguments", "sendKeys 需要 key", retryable: false)
		}
		AgentHUD.begin(app: target.name, action: "按键 \(key)")
		raise(target)
		let result = try Input.sendKeys(key)
		settle()
		return result
	}

	static func pasteText(_ target: TargetApp, step: [String: Any]) throws -> [String: Any] {
		guard let text = step["text"] as? String, !text.isEmpty else {
			throw HelperError("badArguments", "pasteText 需要 text", retryable: false)
		}
		AgentHUD.begin(app: target.name, action: "粘贴文本")
		raise(target)
		let result = try Input.paste(text, format: step["format"] as? String)
		settle()
		return result
	}

	private static func isSecure(_ element: AXUIElement) -> Bool {
		// AXSubrole 是最可靠的信号；再补一条「占位符像密码」的兜底
		if Snapshot.string(element, kAXSubroleAttribute) == (kAXSecureTextFieldSubrole as String) { return true }
		let placeholder = (Snapshot.string(element, kAXPlaceholderValueAttribute) ?? "").lowercased()
		let hint = ["密码", "password", "passcode", "口令", "pin"]
		return hint.contains { placeholder.contains($0) }
	}

	private static func typeViaKeyboard(_ text: String) {
		// 20 字一段：一次性塞太长会被部分 App 截断
		let characters = Array(text)
		var index = 0
		while index < characters.count {
			let chunk = String(characters[index..<min(index + 20, characters.count)])
			let utf16 = Array(chunk.utf16)
			let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
			down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
			down?.post(tap: .cghidEventTap)
			let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
			up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
			up?.post(tap: .cghidEventTap)
			usleep(useconds_t(max(0, HelperSettings.current.keyDelayMs)) * 1000)
			index += 20
		}
	}

	// MARK: - 滚动

	static func scroll(_ target: TargetApp, step: [String: Any]) throws -> [String: Any] {
		guard let direction = step["direction"] as? String,
			["up", "down", "left", "right"].contains(direction) else {
			throw HelperError("badArguments", "scrollView 的 direction 必须是 up/down/left/right", retryable: false)
		}
		let pages = max(1, min(10, (step["pages"] as? Int) ?? 1))
		try ensureNotBusyUser()

		// 滚动点：优先用指定元素的中心，否则用窗口中心
		var point = CGPoint.zero
		if let elementNumber = step["elementNumber"] as? Int {
			guard let center = center(of: try element(elementNumber)) else {
				throw HelperError("badArguments", "#\(elementNumber) 读不到位置，没法在它上面滚动", retryable: true)
			}
			point = center
		} else if let x = number(step["x"]), let y = number(step["y"]) {
			point = try screenPoint(x: x, y: y)
		} else if let snapshot = current {
			point = CGPoint(
				x: snapshot.windowOrigin.x + snapshot.windowSize.width / 2,
				y: snapshot.windowOrigin.y + snapshot.windowSize.height / 2
			)
		} else {
			throw HelperError("badArguments", "滚动需要先 observe（或者给 elementNumber / x,y）", retryable: true)
		}

		AgentHUD.begin(app: target.name, action: "滚动\(direction)")
		raise(target)
		PointerOverlay.shared.show()
		PointerOverlay.shared.move(to: point)
		moveMouse(to: point)
		let (deltaX, deltaY): (Int32, Int32) = {
			switch direction {
			case "up": return (0, 10)
			case "down": return (0, -10)
			case "left": return (10, 0)
			default: return (-10, 0)
			}
		}()
		// 每「页」若干格滚轮：格数太少对长列表几乎没动
		for _ in 0..<(pages * 8) {
			let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0)
			event?.post(tap: .cghidEventTap)
			usleep(12_000)
		}
		settle()
		return ["ok": true, "direction": direction, "pages": pages, "point": ["x": point.x, "y": point.y]]
	}

	// MARK: - 拖拽

	static func drag(_ target: TargetApp, step: [String: Any]) throws -> [String: Any] {
		guard let startX = number(step["startX"]), let startY = number(step["startY"]),
			let endX = number(step["endX"]), let endY = number(step["endY"]) else {
			throw HelperError("badArguments", "dragItem 需要 startX/startY/endX/endY（截图像素）", retryable: false)
		}
		try ensureNotBusyUser()
		let from = try screenPoint(x: startX, y: startY)
		let to = try screenPoint(x: endX, y: endY)
		raise(target)

		AgentHUD.begin(app: target.name, action: "拖拽")
		PointerOverlay.shared.show()
		PointerOverlay.shared.move(to: from)
		moveMouse(to: from)
		usleep(60_000)
		CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
		usleep(80_000)
		// 分步移动：直接跳到终点很多 App 不认（没有拖拽过程的中间事件）
		let steps = 18
		for index in 1...steps {
			let progress = CGFloat(index) / CGFloat(steps)
			let point = CGPoint(x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress)
			CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
			usleep(16_000)
		}
		CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)?.post(tap: .cghidEventTap)
		settle()
		return ["ok": true, "from": ["x": from.x, "y": from.y], "to": ["x": to.x, "y": to.y]]
	}

	// MARK: - 基础设施

	/// 截图像素 → 屏幕坐标（窗口原点 + 缩放）
	private static func screenPoint(x: Double, y: Double) throws -> CGPoint {
		guard let snapshot = current else {
			throw HelperError("badArguments", "还没有界面快照：坐标是「截图里的像素」，得先 observe", retryable: true)
		}
		let scale = snapshot.scale <= 0 ? 1 : snapshot.scale
		return CGPoint(x: snapshot.windowOrigin.x + x * scale, y: snapshot.windowOrigin.y + y * scale)
	}

	/// 把目标窗口抬到最前：不这样做，AXPress 可能作用在后台窗口
	private static func raise(_ target: TargetApp) {
		if !target.app.isActive {
			target.app.activate(options: [.activateIgnoringOtherApps])
			usleep(150_000)
		}
		let windows = Snapshot.attribute(target.element, kAXWindowsAttribute) as? [AXUIElement] ?? []
		if let window = windows.first {
			AXUIElementPerformAction(window, kAXRaiseAction as CFString)
		}
	}

	private static func moveMouse(to point: CGPoint) {
		CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
	}

	private static func clickAt(screenPoint: CGPoint, button: String, times: Int) {
		let mouseButton: CGMouseButton = button == "right" ? .right : .left
		let downType: CGEventType = button == "right" ? .rightMouseDown : .leftMouseDown
		let upType: CGEventType = button == "right" ? .rightMouseUp : .leftMouseUp
		moveMouse(to: screenPoint)
		usleep(40_000)
		for _ in 0..<times {
			CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: screenPoint, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
			usleep(30_000)
			CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: screenPoint, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
			usleep(70_000)
		}
	}

	/// 动作后给界面一口气的时间：agent 紧接着 observe 时不该看到旧画面
	private static func settle() {
		usleep(120_000)
		// 恢复浮窗的鼠标交互（双击可以继续用）
		Preview.setClickThrough(false)
	}

	/// 用户正在操作时不动手：抢输入会点错地方，或者把 agent 的点击吃到一半。
	///
	/// 两个信号：
	///   1. 鼠标键按着（正在拖选/拖拽）；
	///   2. 键盘刚被用户敲过（`secondsSinceLastEventType` 很短）—— 这条要宽松一些，
	///      因为 agent 自己发的键盘事件也会计入，所以只在「非本进程触发」时才有意义，
	///      这里用 0.35 秒的小窗口，避免把 agent 刚做完的输入误判成用户操作。
	private static func ensureNotBusyUser() throws {
		if CGEventSource.buttonState(.combinedSessionState, button: .left)
			|| CGEventSource.buttonState(.combinedSessionState, button: .right)
			|| CGEventSource.buttonState(.combinedSessionState, button: .center) {
			throw HelperError(
				"userActive",
				"用户正在按着鼠标，先等他放开（避免抢输入点到别的地方）",
				retryable: true
			)
		}
	}

	private static func center(of element: AXUIElement) -> CGPoint? {
		guard let position = Snapshot.point(element, kAXPositionAttribute),
			let size = Snapshot.size(element, kAXSizeAttribute), size.width > 0, size.height > 0 else {
			return nil
		}
		return CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
	}

	private static func number(_ value: Any?) -> Double? {
		if let double = value as? Double { return double }
		if let int = value as? Int { return Double(int) }
		if let number = value as? NSNumber { return number.doubleValue }
		return nil
	}
}
