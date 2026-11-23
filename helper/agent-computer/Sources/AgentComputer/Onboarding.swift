import AppKit

/// 首次运行引导窗口。
///
/// 为什么需要它：macOS 的隐私授权不允许程序自己勾自己（TCC 是系统级保护），
/// 所以能优化的只有「路径」——把「打开系统设置 → 隐私与安全性 → 辅助功能 →
/// 找到条目 → 勾选」压缩成「点一个按钮 → 勾一下」，并且自动轮询结果。
///
/// 关键细节：**先调用带 prompt 的权限 API，再打开设置面板**。
/// 不先调一次，`Agent Computer` 根本不会出现在辅助功能列表里，用户会以为程序坏了。
final class Onboarding: NSObject, NSWindowDelegate {
	static let shared = Onboarding()

	private var window: NSWindow?
	private var timer: Timer?
	private var accessibilityLabel: NSTextField?
	private var screenLabel: NSTextField?
	private var hintLabel: NSTextField?
	private var doneButton: NSButton?
	private var grantedAt: Date?
	private var lastBeep = Date.distantPast

	private let supportDir = FileManager.default.homeDirectoryForCurrentUser
		.appendingPathComponent("Library/Application Support/AgentComputer")

	private var markerFile: URL { supportDir.appendingPathComponent("onboarding.json") }

	/// 用户点过「稍后」就不再自动弹（但菜单栏随时能叫出来）
	private var dismissed: Bool {
		guard let data = try? Data(contentsOf: markerFile),
			let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
			return false
		}
		return json["dismissed"] as? Bool ?? false
	}

	private func markDismissed() {
		try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
		let json: [String: Any] = ["dismissed": true, "at": ISO8601DateFormatter().string(from: Date())]
		if let data = try? JSONSerialization.data(withJSONObject: json) {
			try? data.write(to: markerFile)
		}
	}

	/// 启动时调用：没有权限且没被「稍后」过，就弹一次系统提示 + 显示引导窗口
	func showIfNeeded() {
		let ready = Permissions.accessibilityGranted() && Permissions.screenRecordingGranted()
		guard !ready else { return }
		if !dismissed {
			// 这一步会弹系统对话框「想控制这台电脑」，同时把 app 加进辅助功能列表
			Permissions.requestAccessibility()
		}
		show()
		registerScreenRecording()
	}

	/// 把 app **登记进「录屏与系统录音」列表**（用户 2026-11-23：「默认没添加进去」）。
	///
	/// 为什么必须单独调一次：`CGPreflight…` 是纯读的状态检查，**不会**让 app 出现在那个列表里；
	/// 只有 `CGRequest…` 才会写 TCC 记录。以前只有引导窗上的「去授权」按钮调它，
	/// 所以没点过那个按钮的机器上，用户打开系统设置根本找不到「Agent Computer」这一条。
	///
	/// 放在窗口显示之后、下一拍再调：这个调用会一直等到用户回答系统提示才返回，
	/// 直接写在 `applicationDidFinishLaunching` 里会让引导窗口卡着不出现。
	/// 这里只做「登记」，**不强迫开启** —— 开关由用户自己决定。
	private func registerScreenRecording() {
		guard !Permissions.screenRecordingGranted() else { return }
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
			guard let self, !Permissions.screenRecordingGranted() else { return }
			let granted = Permissions.requestScreenRecording()
			Log.write("申请屏幕录制（登记进列表）：granted=\(granted)")
			self.refresh()
		}
	}

	func show() {
		if let window {
			placeWindow(window)
			window.makeKeyAndOrderFront(nil)
			window.orderFrontRegardless()
			NSApp.activate(ignoringOtherApps: true)
			refresh()
			beepOnce()
			return
		}
		let window = buildWindow()
		self.window = window
		placeWindow(window)
		NSApp.activate(ignoringOtherApps: true)
		window.makeKeyAndOrderFront(nil)
		// accessory app 的 activate 可能被系统忽略：再强制抬一次，避免「点了没反应」
		window.orderFrontRegardless()
		refresh()
		startPolling()
		beepOnce()
		Log.write(
			"引导窗口：visible=\(window.isVisible) frame=\(window.frame) "
				+ "screen=\(window.screen?.frame.debugDescription ?? "nil") "
				+ "occlusion=\(window.occlusionState.rawValue) "
				+ "policy=\(NSApp.activationPolicy().rawValue) active=\(NSApp.isActive)"
		)
	}

	/// 放到「鼠标所在的那块屏幕」中央。
	///
	/// 多屏时 `window.center()` 可能落到副屏上 —— 用户在另一块屏幕上双击，就会以为程序没反应。
	private func placeWindow(_ window: NSWindow) {
		let mouse = NSEvent.mouseLocation
		let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
		guard let visible = screen?.visibleFrame else { return }
		let size = window.frame.size
		window.setFrameOrigin(
			NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2)
		)
	}

	/// 一声轻提示：窗口在副屏/被遮挡时，声音至少说明「它起来了」
	private func beepOnce() {
		guard Date().timeIntervalSince(lastBeep) > 3 else { return }
		lastBeep = Date()
		NSSound(named: "Ping")?.play()
	}

	// MARK: - 界面

	private func buildWindow() -> NSWindow {
		let window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 580, height: 330),
			styleMask: [.titled, .closable, .fullSizeContentView],
			backing: .buffered,
			defer: false
		)
		window.title = "Agent Computer"
		window.titlebarAppearsTransparent = true
		window.isReleasedWhenClosed = false
		window.delegate = self
		// 关键：后台 app 抢不到前台（macOS 限制），所以靠「层级 + 跟随所有 Space」保证可见。
		// .statusBar 高于普通/浮动窗口，能压在最大化的 Chrome 之上；全屏 Space 由 fullScreenAuxiliary 覆盖。
		window.level = .statusBar
		window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

		let icon = NSImageView()
		icon.image = NSApp.applicationIconImage
		icon.imageScaling = .scaleProportionallyUpOrDown
		icon.translatesAutoresizingMaskIntoConstraints = false
		icon.widthAnchor.constraint(equalToConstant: 64).isActive = true
		icon.heightAnchor.constraint(equalToConstant: 64).isActive = true

		let title = NSTextField(labelWithString: "还差一步就能用了")
		title.font = .systemFont(ofSize: 20, weight: .semibold)

		let subtitle = NSTextField(
			wrappingLabelWithString: "macOS 不允许应用自己给自己授权（这是系统保护），\n需要你在系统设置里勾一下。点下面的按钮会直接跳到对应位置。"
		)
		subtitle.font = .systemFont(ofSize: 12)
		subtitle.textColor = .secondaryLabelColor

		let header = NSStackView(views: [icon, NSStackView(views: [title, subtitle])])
		header.orientation = .horizontal
		header.alignment = .centerY
		header.spacing = 14

		let accessibilityRow = makePermissionRow(
			name: "辅助功能",
			detail: "读界面、点击、输入都要它",
			action: #selector(grantAccessibility)
		)
		accessibilityLabel = accessibilityRow.status
		let screenRow = makePermissionRow(
			name: "屏幕录制",
			detail: "只用来看截图，不给也能操作",
			action: #selector(grantScreenRecording)
		)
		screenLabel = screenRow.status

		let hint = NSTextField(wrappingLabelWithString: "")
		hint.font = .systemFont(ofSize: 12)
		hint.textColor = .secondaryLabelColor
		hintLabel = hint

		let later = NSButton(title: "稍后", target: self, action: #selector(dismiss))
		later.bezelStyle = .rounded
		let done = NSButton(title: "已授权，重新检测", target: self, action: #selector(donePressed))
		done.bezelStyle = .rounded
		done.keyEquivalent = "\r"
		doneButton = done

		let footer = NSStackView(views: [hint, NSView(), later, done])
		footer.orientation = .horizontal
		footer.alignment = .centerY
		footer.spacing = 8

		let stack = NSStackView(views: [header, divider(), accessibilityRow.view, screenRow.view, divider(), footer])
		stack.orientation = .vertical
		stack.alignment = .leading
		stack.spacing = 14
		stack.edgeInsets = NSEdgeInsets(top: 22, left: 24, bottom: 20, right: 24)
		stack.translatesAutoresizingMaskIntoConstraints = false

		let content = NSView()
		content.addSubview(stack)
		NSLayoutConstraint.activate([
			stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
			stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
			stack.topAnchor.constraint(equalTo: content.topAnchor),
			stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
		])
		window.contentView = content
		return window
	}

	private func divider() -> NSBox {
		let box = NSBox()
		box.boxType = .separator
		return box
	}

	private func makePermissionRow(name: String, detail: String, action: Selector) -> (view: NSView, status: NSTextField) {
		let nameLabel = NSTextField(labelWithString: name)
		nameLabel.font = .systemFont(ofSize: 13, weight: .medium)
		nameLabel.widthAnchor.constraint(equalToConstant: 84).isActive = true

		let detailLabel = NSTextField(labelWithString: detail)
		detailLabel.font = .systemFont(ofSize: 11)
		detailLabel.textColor = .tertiaryLabelColor

		let left = NSStackView(views: [nameLabel, detailLabel])
		left.orientation = .vertical
		left.alignment = .leading
		left.spacing = 2

		let status = NSTextField(labelWithString: "检查中…")
		status.font = .systemFont(ofSize: 12)
		status.textColor = .secondaryLabelColor

		let button = NSButton(title: "去授权", target: self, action: action)
		button.bezelStyle = .rounded
		button.controlSize = .regular

		let row = NSStackView(views: [left, NSView(), status, button])
		row.orientation = .horizontal
		row.alignment = .centerY
		row.spacing = 10
		return (row, status)
	}

	// MARK: - 动作

	@objc private func grantAccessibility() {
		// 顺序很重要：先请求（让 app 出现在列表里），再打开面板
		Permissions.requestAccessibility()
		openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
		refresh()
	}

	@objc private func grantScreenRecording() {
		Permissions.requestScreenRecording()
		openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
		refresh()
	}

	/// 按钮在「已就绪」后变成「完成」，点它直接关窗；否则只是重新检测
	@objc private func donePressed() {
		if Permissions.accessibilityGranted() && Permissions.screenRecordingGranted() {
			window?.orderOut(nil)
			return
		}
		if Permissions.accessibilityGranted() {
			// 屏幕录制授权后必须重启进程才生效
			restartHelper()
			return
		}
		refresh()
	}

	@objc private func dismiss() {
		markDismissed()
		window?.orderOut(nil)
	}

	@objc private func refresh() {
		let accessibility = Permissions.accessibilityGranted()
		let screen = Permissions.screenRecordingGranted()

		accessibilityLabel?.stringValue = accessibility ? "✓ 已允许" : "✗ 未允许"
		accessibilityLabel?.textColor = accessibility ? .systemGreen : .systemOrange
		screenLabel?.stringValue = screen ? "✓ 已允许" : "✗ 未允许"
		screenLabel?.textColor = screen ? .systemGreen : .systemOrange

		if accessibility && screen {
			hintLabel?.stringValue = "都好了，现在可以开始操作。"
			doneButton?.title = "完成"
			if grantedAt == nil { grantedAt = Date() }
			// 让用户看见「已允许」再自动关掉，不要一闪而过
			if let grantedAt, Date().timeIntervalSince(grantedAt) > 1.2 {
				window?.orderOut(nil)
			}
		} else if accessibility {
			hintLabel?.stringValue = "辅助功能已就绪。屏幕录制授权后需要重启一次 helper 才会生效。"
			doneButton?.title = "重启 helper"
		} else {
			hintLabel?.stringValue = "在系统设置里勾上「Agent Computer」，回到这里会自动变成已允许。"
			doneButton?.title = "已授权，重新检测"
		}
	}

	private func startPolling() {
		timer?.invalidate()
		timer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
			guard let self else { return }
			self.refresh()
			if self.window?.isVisible != true {
				self.timer?.invalidate()
				self.timer = nil
			}
		}
	}

	/// 屏幕录制授权后必须重启进程才生效
	func restartHelper() {
		let bundle = Bundle.main
		if bundle.bundleIdentifier != nil {
			let process = Process()
			process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
			process.arguments = ["-a", bundle.bundlePath]
			try? process.run()
		} else {
			let process = Process()
			process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
			try? process.run()
		}
		exit(0)
	}

	private func openSettings(_ target: String) {
		guard let url = URL(string: target) else { return }
		NSWorkspace.shared.open(url)
	}

	func windowWillClose(_ notification: Notification) {
		timer?.invalidate()
		timer = nil
	}
}
