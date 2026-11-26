import AppKit

/// 菜单栏常驻入口。
///
/// LSUIElement 的 app 没有 Dock 图标，用户点完授权后就找不到它了 ——
/// 所以必须有个常驻可见的入口：重新打开引导、跳授权设置、重启、退出。
/// 授权状态不在这里列，打开引导窗口就能看到，重复一遍只是噪音。
final class StatusMenu: NSObject {
	private let item: NSStatusItem

	override init() {
		item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
		super.init()
		if let button = item.button {
			let image = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: "Agent Computer")
			image?.isTemplate = true
			button.image = image
			button.toolTip = "Agent Computer"
		}
		let menu = NSMenu()
		menu.addItem(withTitle: "打开引导窗口…", action: #selector(openOnboarding), keyEquivalent: "").target = self
		menu.addItem(.separator())
		menu.addItem(withTitle: "打开「辅助功能」设置…", action: #selector(openAccessibility), keyEquivalent: "").target = self
		menu.addItem(withTitle: "打开「屏幕录制」设置…", action: #selector(openScreenRecording), keyEquivalent: "").target = self
		menu.addItem(.separator())
		menu.addItem(withTitle: "重启", action: #selector(restart), keyEquivalent: "").target = self
		menu.addItem(withTitle: "退出", action: #selector(quit), keyEquivalent: "q").target = self
		item.menu = menu
	}

	@objc private func openOnboarding() {
		Onboarding.shared.show()
	}

	@objc private func openAccessibility() {
		Permissions.requestAccessibility()
		NSWorkspace.shared.open(
			URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
		)
	}

	@objc private func openScreenRecording() {
		Permissions.requestScreenRecording()
		NSWorkspace.shared.open(
			URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
		)
	}

	@objc private func restart() {
		Onboarding.shared.restartHelper()
	}

	@objc private func quit() {
		NSApp.terminate(nil)
	}
}
