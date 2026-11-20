import AppKit

/// 实时预览浮窗：操作时让用户看见「agent 现在看到的是哪一屏」。
///
/// 必须回到主线程创建窗口 —— 所以 main.swift 里让主线程跑 NSApplication，
/// socket 服务放在后台线程。
enum Preview {
	private static var window: NSWindow?
	private static var imageLayer: CALayer?
	private static var statusLabel: NSTextField?
	/// 程序自己摆放窗口时不要触发「记住位置」
	private static var placingProgrammatically = false

	/// 可拖动容器：`isMovableByWindowBackground` 只在点到窗口空白处才生效，
	/// 而这里的图片铺满了整个窗口，所以显式用 performDrag 处理 mouseDown。
	private final class DragContainer: NSView {
		override func mouseDown(with event: NSEvent) {
			let point = convert(event.locationInWindow, from: nil)
			// 点在按钮上：交给按钮处理，否则会变成「拖窗口」，按钮永远点不到
			if let button = hitTest(point) as? NSButton {
				button.mouseDown(with: event)
				return
			}
			window?.performDrag(with: event)
		}

		override func rightMouseDown(with event: NSEvent) {
			// 右键也能关：小按钮不好点的时候有个退路
			NSMenu.popUpContextMenu(menu ?? Preview.contextMenu(), with: event, for: self)
		}
	}

	/// 拖动结束后把位置写进 settings.json
	private final class WindowDelegate: NSObject, NSWindowDelegate {
		func windowDidMove(_ notification: Notification) {
			guard !Preview.placingProgrammatically else { return }
			// 拖动会连续触发 didMove，等到停下来再存一次最终位置。
			// 不能靠「鼠标是否按着」判断：performDrag 结束时的最后一次回调里按键已经松开。
			Preview.schedulePersist()
		}
	}

	private static let windowDelegate = WindowDelegate()
	/// 三档尺寸：双击浮窗循环切换，选择会记到 settings.json
	private static let sizes: [String: NSSize] = [
		"small": NSSize(width: 384, height: 268),
		"medium": NSSize(width: 560, height: 380),
		"large": NSSize(width: 800, height: 540),
	]
	static let sizeOrder = ["small", "medium", "large"]
	private static var sizeName: String { HelperSettings.current.previewSize }
	private static var currentSize: NSSize { sizes[sizeName] ?? sizes["small"]! }
	/// 窗口还没建时先记住文案，建好后立刻套上去（否则第一次永远是「等待操作…」）
	private static var pendingStatus: String?

	/// 更新浮窗顶部那行说明：既让用户知道 AI 在看什么，也方便排查
	static func setStatus(_ text: String) {
		pendingStatus = text
		DispatchQueue.main.async {
			statusLabel?.stringValue = text
		}
	}

	/// 动作执行期间让浮窗「穿透」鼠标：否则 agent 的坐标点击可能打到浮窗上
	static func setClickThrough(_ on: Bool) {
		DispatchQueue.main.async {
			window?.ignoresMouseEvents = on
		}
	}

	/// 双击切换大小（小 → 中 → 大 → 小），并记住选择
	static func cycleSize() {
		let index = sizeOrder.firstIndex(of: sizeName) ?? 0
		let next = sizeOrder[(index + 1) % sizeOrder.count]
		saveSize(next)
		resize(to: next)
	}

	private static func resize(to name: String) {
		guard let window, let size = sizes[name] else { return }
		let current = window.frame
		// 以中心为基准缩放，避免「放大后跑到屏幕外」
		let center = NSPoint(x: current.midX, y: current.midY)
		place(NSRect(x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height))
	}

	/// 用户双击换档时：换完尺寸再记住新位置（缩放会把窗口挪一点）
	static func cycleSizeAndPersist() {
		cycleSize()
		persistPosition()
	}

	/// 统一摆放：标记为「程序自己摆的」，免得触发保存；同时保证窗口还在屏幕里
	private static func place(_ frame: NSRect) {
		guard let window else { return }
		placingProgrammatically = true
		window.setFrame(clamped(frame), display: true)
		placingProgrammatically = false
	}

	/// 拖动到屏幕外时拉回来（换显示器/改分辨率后不会「消失」）
	private static func clamped(_ frame: NSRect) -> NSRect {
		let screens = NSScreen.screens
		guard !screens.isEmpty else { return frame }
		let union = screens.dropFirst().reduce(screens[0].frame) { $0.union($1.frame) }
		var origin = frame.origin
		origin.x = min(max(origin.x, union.minX), union.maxX - frame.width)
		origin.y = min(max(origin.y, union.minY), union.maxY - frame.height)
		return NSRect(origin: origin, size: frame.size)
	}

	private static var persistWork: DispatchWorkItem?

	/// 右键菜单：关闭浮窗 / 切换大小
	static func contextMenu() -> NSMenu {
		let menu = NSMenu()
		let closeItem = NSMenuItem(title: "关闭浮窗", action: #selector(GestureTarget.close), keyEquivalent: "")
		closeItem.target = gestureTarget
		let sizeItem = NSMenuItem(title: "切换大小", action: #selector(GestureTarget.doubleClick), keyEquivalent: "")
		sizeItem.target = gestureTarget
		menu.addItem(closeItem)
		menu.addItem(sizeItem)
		return menu
	}

	/// 点 ✕：收起浮窗，并把 `preview.enabled` 写成 false（面板里的开关同步变掉）
	static func closeAndDisable() {
		show(false)
		let home = FileManager.default.homeDirectoryForCurrentUser
		let file = home.appendingPathComponent("Library/Application Support/AgentComputer/settings.json")
		var root: [String: Any] = [:]
		if let data = try? Data(contentsOf: file),
			let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
			root = parsed
		}
		var preview = root["preview"] as? [String: Any] ?? [:]
		preview["enabled"] = false
		root["preview"] = preview
		if let data = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]) {
			try? data.write(to: file, options: .atomic)
		}
		HelperSettings.invalidate()
	}

	/// 拖动停下 0.4 秒后再写盘，避免拖动过程中反复写文件
	static func schedulePersist() {
		persistWork?.cancel()
		let work = DispatchWorkItem { Preview.persistPosition() }
		persistWork = work
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
	}

	/// 只写 preview.x / preview.y，其它键原样保留
	private static func persistPosition() {
		guard let window else { return }
		let home = FileManager.default.homeDirectoryForCurrentUser
		let file = home.appendingPathComponent("Library/Application Support/AgentComputer/settings.json")
		var root: [String: Any] = [:]
		if let data = try? Data(contentsOf: file),
			let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
			root = parsed
		}
		var preview = root["preview"] as? [String: Any] ?? [:]
		preview["x"] = Double(window.frame.origin.x)
		preview["y"] = Double(window.frame.origin.y)
		root["preview"] = preview
		if let data = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]) {
			try? data.write(to: file, options: .atomic)
		}
		HelperSettings.invalidate()
	}

	/// 写回 settings.json 的 `preview.size`，只碰这一个键
	private static func saveSize(_ name: String) {
		let home = FileManager.default.homeDirectoryForCurrentUser
		let file = home.appendingPathComponent("Library/Application Support/AgentComputer/settings.json")
		var root: [String: Any] = [:]
		if let data = try? Data(contentsOf: file),
			let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
			root = parsed
		}
		var preview = root["preview"] as? [String: Any] ?? [:]
		preview["size"] = name
		root["preview"] = preview
		if let data = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]) {
			try? data.write(to: file, options: .atomic)
		}
		HelperSettings.invalidate()
	}

	/// 手势需要一个 NSObject 作为 target
	private final class GestureTarget: NSObject {
		@objc func doubleClick() {
			Preview.cycleSizeAndPersist()
		}

		@objc func close() {
			Preview.closeAndDisable()
		}
	}

	private static let gestureTarget = GestureTarget()

	/// 按设置决定是否显示（observe 之后调用；面板一勾上，下一次 observe 就生效）
	static func syncWithSettings() {
		let enabled = HelperSettings.current.previewEnabled
		show(enabled)
	}

	static func show(_ on: Bool) {
		DispatchQueue.main.async {
			if on {
				let window = makeWindowIfNeeded()
				// 只在尺寸不一致时才重排：新窗口刚创建时坐标还没摆好，
				// 无条件 resize 会按 (0,0) 的中心计算，把窗口挪到左下角
				if abs(window.frame.width - currentSize.width) > 1 {
					resize(to: sizeName)
				}
				window.orderFrontRegardless()
			} else {
				window?.orderOut(nil)
			}
		}
	}

	/// 用最新截图刷新浮窗；拿不到就给一句明确原因，不要留个没解释的黑框
	static func refresh(path: String?, reason: String? = nil) {
		DispatchQueue.main.async {
			guard let imageLayer else { return }
			let image = path.flatMap { NSImage(contentsOfFile: $0) }
				?? placeholder(reason ?? "这张截图拿不到（应用可能被遮挡，或窗口受系统保护）")
			imageLayer.contents = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
		}
	}

	/// 占位图：标题 + 一行说明，确认窗口真的在工作
	private static func placeholder(_ subtitle: String = "等待第一张截图…") -> NSImage {
		let size = NSSize(width: 720, height: 480)
		let image = NSImage(size: size)
		image.lockFocus()
		NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
		NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()
		let title = "Agent Computer"
		(title as NSString).draw(
			at: NSPoint(x: 40, y: size.height - 64),
			withAttributes: [.font: NSFont.systemFont(ofSize: 26, weight: .semibold), .foregroundColor: NSColor.white]
		)
		(subtitle as NSString).draw(
			at: NSPoint(x: 40, y: size.height - 100),
			withAttributes: [.font: NSFont.systemFont(ofSize: 16), .foregroundColor: NSColor(calibratedWhite: 0.7, alpha: 1)]
		)
		image.unlockFocus()
		return image
	}

	private static func makeWindowIfNeeded() -> NSWindow {
		if let window { return window }
		// 整个创建+摆位过程都不记录位置：此时 frame 还可能是 (0,0)
		placingProgrammatically = true
		defer { placingProgrammatically = false }
		let size = currentSize
		// 必须是 NSPanel + .nonactivatingPanel：
		// 普通 NSWindow 在「非激活 app」里点一下只算激活窗口，拖不动；
		// 这个组合可以在不切换前台的情况下直接拖动。
		let window = NSPanel(
			contentRect: NSRect(origin: .zero, size: size),
			styleMask: [.borderless, .nonactivatingPanel],
			backing: .buffered,
			defer: false
		)
		window.becomesKeyOnlyIfNeeded = true
		window.isFloatingPanel = true
		window.hidesOnDeactivate = false
		window.delegate = windowDelegate
		window.isOpaque = false
		window.alphaValue = 0.96
		// 压在全屏应用之上，用户切到别的窗口也能看到 AI 在看什么
		window.level = .statusBar
		window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
		window.ignoresMouseEvents = false
		window.backgroundColor = .clear
		window.hasShadow = true

		let container = DragContainer(frame: NSRect(origin: .zero, size: size))
		container.wantsLayer = true
		container.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.82).cgColor
		container.layer?.cornerRadius = 12
		container.layer?.borderWidth = 1
		container.layer?.borderColor = NSColor.white.withAlphaComponent(0.16).cgColor

		let header = NSView(frame: NSRect(x: 0, y: size.height - 30, width: size.width, height: 30))
		header.autoresizingMask = [.width, .minYMargin]

		let dot = NSView(frame: NSRect(x: 12, y: 12, width: 7, height: 7))
		dot.wantsLayer = true
		dot.layer?.backgroundColor = NSColor.systemGreen.cgColor
		dot.layer?.cornerRadius = 3.5

		let label = NSTextField(labelWithString: pendingStatus ?? "等待操作…")
		label.font = .systemFont(ofSize: 11.5, weight: .medium)
		label.textColor = NSColor.white.withAlphaComponent(0.92)
		label.lineBreakMode = .byTruncatingTail
		label.frame = NSRect(x: 26, y: 9, width: size.width - 38, height: 15)
		label.autoresizingMask = [.width]
		// 关闭按钮：点了就把浮窗收起来，并且关掉「显示实时预览浮窗」开关，
		// 否则下一次 observe 又会自动弹出来，用户会觉得「关不掉」
		let close = NSButton(
			image: NSImage(systemSymbolName: "xmark", accessibilityDescription: "关闭浮窗")!,
			target: gestureTarget,
			action: #selector(GestureTarget.close)
		)
		close.isBordered = false
		close.contentTintColor = NSColor.white.withAlphaComponent(0.65)
		close.imageScaling = .scaleProportionallyDown
		close.frame = NSRect(x: size.width - 34, y: size.height - 32, width: 24, height: 24)
		close.autoresizingMask = [.minXMargin, .minYMargin]
		close.toolTip = "关闭浮窗（同时关闭「显示实时预览浮窗」）"

		header.addSubview(dot)
		header.addSubview(label)

		// 用 CALayer 而不是 NSImageView：NSImageView 会吃掉 mouseDown，
		// 导致「按住浮窗拖动」完全没反应（窗口的 performDrag 收不到事件）
		let imageLayer = CALayer()
		imageLayer.frame = NSRect(x: 8, y: 8, width: size.width - 16, height: size.height - 46)
		imageLayer.cornerRadius = 8
		imageLayer.masksToBounds = true
		imageLayer.contentsGravity = .resizeAspect
		imageLayer.backgroundColor = NSColor.black.withAlphaComponent(0.5).cgColor
		imageLayer.borderWidth = 1
		imageLayer.borderColor = NSColor.white.withAlphaComponent(0.12).cgColor
		imageLayer.contents = placeholder().cgImage(forProposedRect: nil, context: nil, hints: nil)
		container.layer?.addSublayer(imageLayer)

		container.addSubview(header)
		container.addSubview(close)
		window.contentView = container

		// 双击切换大小；鼠标悬停给一句提示
		let gesture = NSClickGestureRecognizer(target: gestureTarget, action: #selector(GestureTarget.doubleClick))
		gesture.numberOfClicksRequired = 2
		header.addGestureRecognizer(gesture)
		container.toolTip = "拖动移动位置；双击标题栏切换大小"

		// 先登记窗口，place() 内部要用到 Preview.window；否则定位会被静默跳过，窗口停在 (0,0)
		Preview.window = window
		Preview.imageLayer = imageLayer
		Preview.statusLabel = label

		// 位置：记住过就还原（并做可见性校正），否则放主屏右下角
		if let x = HelperSettings.current.previewX, let y = HelperSettings.current.previewY {
			place(NSRect(x: x, y: y, width: size.width, height: size.height))
		} else {
			let screen = NSScreen.screens.first ?? NSScreen.main
			if let frame = screen?.visibleFrame {
				place(NSRect(x: frame.maxX - size.width - 20, y: frame.minY + 20, width: size.width, height: size.height))
			}
		}

		return window
	}
}
