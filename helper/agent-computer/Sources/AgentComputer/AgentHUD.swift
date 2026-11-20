import Foundation

/// 「AI 正在操作」的统一入口。
///
/// 每次动作都调一次 `begin`：屏幕水印 + 小浮窗的状态行一起更新，
/// 用户在任何界面都能知道 AI 现在在做什么。
enum AgentHUD {
	static func begin(app: String, action: String) {
		let text = "\(app) · \(action)"
		Watermark.shared.show("AI 正在操作 · \(text)")
		Preview.setStatus(text)
		Preview.syncWithSettings()
		// 动作期间浮窗穿透鼠标，避免 agent 的点击打到浮窗上
		Preview.setClickThrough(true)
	}

	/// 只更新浮窗（比如 observe 这种「看」而不「动」的动作），不弹水印
	static func watching(app: String, action: String = "读取界面") {
		Preview.setStatus("\(app) · \(action)")
		Preview.syncWithSettings()
	}

	static func finish() {
		Watermark.shared.hide()
		Preview.show(false)
		PointerOverlay.shared.hide()
	}
}
