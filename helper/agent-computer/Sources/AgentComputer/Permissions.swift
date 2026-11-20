import AppKit
import ApplicationServices

/// 权限状态：辅助功能（驱动界面）与屏幕录制（截图）。
enum Permissions {
	/// 只读检查，不弹框（hello / status 用这个，探活不应该打扰用户）
	static func accessibilityGranted() -> Bool {
		AXIsProcessTrusted()
	}

	/// 只读检查屏幕录制权限（CGPreflight 不弹框）
	static func screenRecordingGranted() -> Bool {
		CGPreflightScreenCaptureAccess()
	}

	/// 主动申请：会弹系统提示 / 把 App 加进「辅助功能」列表
	@discardableResult
	static func requestAccessibility() -> Bool {
		let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
		return AXIsProcessTrustedWithOptions(options)
	}

	@discardableResult
	static func requestScreenRecording() -> Bool {
		CGRequestScreenCaptureAccess()
	}

	static func snapshot() -> [String: Any] {
		[
			"accessibility": accessibilityGranted(),
			"screenRecording": screenRecordingGranted(),
		]
	}
}
