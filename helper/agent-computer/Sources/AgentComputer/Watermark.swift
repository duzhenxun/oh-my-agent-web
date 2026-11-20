import AppKit

extension Array {
	subscript(safe index: Int) -> Element? {
		indices.contains(index) ? self[index] : nil
	}
}

/// 屏幕水印：告诉用户「AI 现在正在操作这台电脑」。
///
/// 为什么必须有：agent 会移动真实光标、抢前台、连续点击。用户如果不知道，
/// 会以为电脑出问题了。所以只要有一次动作，就在屏幕边缘显示呼吸描边 + 顶部胶囊。
///
/// 两个踩过的坑：
///   1. **一块窗口不能横跨多个显示器** —— 用「所有屏幕的并集」当 frame，
///      系统根本不会合成它（调试时表现为 visible=true 但屏幕上什么都没有）。
///      正确做法：每块屏幕各开一个窗口。
///   2. 不要依赖 alpha 淡入动画：后台 app 的动画可能不执行，alpha 停在 0 就永远看不见。
final class Watermark {
	static let shared = Watermark()

	private var windows: [NSWindow] = []
	private var labels: [NSTextField] = []
	private var pills: [NSView] = []
	/// 屏幕上一次布局时的配置，用于判断是否需要重建
	private var screenFrames: [NSRect] = []
	private var hideWork: DispatchWorkItem?

	func show(_ text: String) {
		guard HelperSettings.current.watermarkEnabled else {
			// 开关关掉时立刻收起已经显示的水印
			hide()
			return
		}
		DispatchQueue.main.async { [weak self] in
			guard let self else { return }
			self.rebuildIfNeeded()
			for label in self.labels { label.stringValue = text }
			self.layoutPills()
			for window in self.windows {
				window.alphaValue = 1
				window.orderFrontRegardless()
			}
			self.scheduleHide()
		}
	}

	func hide() {
		DispatchQueue.main.async { [weak self] in
			guard let self else { return }
			self.hideWork?.cancel()
			for window in self.windows { window.orderOut(nil) }
		}
	}

	// MARK: - 内部

	/// 胶囊：按文字长度自适应宽度，水平居中，放在菜单栏下方（别压住系统菜单）
	private func layoutPills() {
		for (index, window) in windows.enumerated() {
			guard let pill = pills[safe: index], let label = labels[safe: index] else { continue }
			let height = window.frame.height
			let width = min(560, max(220, label.intrinsicContentSize.width + 56))
			pill.frame = NSRect(x: (window.frame.width - width) / 2, y: height - 34 - 44, width: width, height: 34)
			label.frame = NSRect(x: 30, y: 8, width: width - 44, height: 18)
		}
	}

	private func scheduleHide() {
		hideWork?.cancel()
		let work = DispatchWorkItem { [weak self] in self?.hide() }
		hideWork = work
		DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
	}

	/// 屏幕数量/布局变了就重建（插拔显示器、改分辨率）
	private func rebuildIfNeeded() {
		let frames = NSScreen.screens.map { $0.frame }
		guard frames != screenFrames || windows.isEmpty else {
			for (index, frame) in frames.enumerated() where index < windows.count {
				windows[index].setFrame(frame, display: false)
			}
			return
		}
		for window in windows { window.orderOut(nil) }
		windows.removeAll()
		labels.removeAll()
		pills.removeAll()

		for screen in NSScreen.screens {
			let window = makeWindow(for: screen)
			windows.append(window)
		}
		screenFrames = frames
	}

	private func makeWindow(for screen: NSScreen) -> NSWindow {
		let frame = screen.frame
		let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
		window.isOpaque = false
		window.backgroundColor = .clear
		window.hasShadow = false
		window.level = .statusBar
		window.ignoresMouseEvents = true
		window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
		window.isMovable = false

		let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
		content.wantsLayer = true

		// 描边：呼吸效果，余光可见但不挡内容
		let border = NSView(frame: content.bounds)
		border.wantsLayer = true
		border.layer?.borderWidth = 4
		border.layer?.borderColor = NSColor.systemBlue.withAlphaComponent(0.9).cgColor
		border.autoresizingMask = [.width, .height]
		let breathe = CABasicAnimation(keyPath: "opacity")
		breathe.fromValue = 0.45
		breathe.toValue = 1
		breathe.duration = 1.1
		breathe.autoreverses = true
		breathe.repeatCount = .infinity
		border.layer?.add(breathe, forKey: "breathe")

		// 顶部胶囊：黑底白字，任何壁纸下都清楚
		let pillHeight: CGFloat = 34
		let pill = NSView(frame: NSRect(x: 0, y: frame.height - pillHeight - 12, width: 320, height: pillHeight))
		pill.wantsLayer = true
		pill.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.78).cgColor
		pill.layer?.cornerRadius = pillHeight / 2
		pill.layer?.borderWidth = 1
		pill.layer?.borderColor = NSColor.white.withAlphaComponent(0.2).cgColor
		pill.autoresizingMask = []

		let dot = NSView(frame: NSRect(x: 14, y: (pillHeight - 8) / 2, width: 8, height: 8))
		dot.wantsLayer = true
		dot.layer?.backgroundColor = NSColor.systemGreen.cgColor
		dot.layer?.cornerRadius = 4
		let pulse = CABasicAnimation(keyPath: "opacity")
		pulse.fromValue = 1
		pulse.toValue = 0.25
		pulse.duration = 0.7
		pulse.autoreverses = true
		pulse.repeatCount = .infinity
		dot.layer?.add(pulse, forKey: "pulse")

		let label = NSTextField(labelWithString: "AI 正在操作")
		label.font = .systemFont(ofSize: 13, weight: .medium)
		label.textColor = .white
		label.lineBreakMode = .byTruncatingTail
		label.frame = NSRect(x: 30, y: (pillHeight - 18) / 2, width: 320 - 40, height: 18)

		pill.addSubview(dot)
		pill.addSubview(label)
		content.addSubview(border)
		content.addSubview(pill)
		window.contentView = content

		labels.append(label)
		pills.append(pill)
		return window
	}
}
