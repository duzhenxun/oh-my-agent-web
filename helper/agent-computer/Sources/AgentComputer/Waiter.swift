import AppKit
import ApplicationServices

/// 等待界面变化。agent 点完按钮后不该盲猜，等一个**可验证的条件**再继续。
///
/// 六种条件（与 skill 文档一致）：
///   text_appears / text_gone  界面上出现/消失了某段文字
///   element_changes           指定编号元素的 value/title 变了
///   new_window                多了一个窗口
///   settled                   界面连续两次快照完全一致（稳定了）
///   any_change                界面有任何变化
enum Waiter {
	static func wait(_ target: TargetApp, payload: [String: Any], deadline: Date) throws -> [String: Any] {
		guard let until = payload["until"] as? String, !until.isEmpty else {
			throw HelperError("badArguments", "waitFor 需要 until", retryable: false)
		}
		let timeoutMs = min(60_000, max(200, (payload["timeoutMs"] as? Int) ?? 10_000))
		let text = payload["text"] as? String
		let elementNumber = payload["elementNumber"] as? Int
		// 取「客户端截止时间」和「自己声明的超时」里更早的那个
		let ownDeadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
		let deadline = min(ownDeadline, self.deadlineLimit(deadline, fallback: ownDeadline))
		let started = Date()

		// 基线快照：判断「变化」要和上一次比
		var previous = try Snapshot.capture(target, fullTree: false)
		let baselineText = previous.lines.joined(separator: "\n")
		let baselineWindows = windowCount(target)
		let baselineElement = elementNumber.flatMap { key in previous.elements[key].map { signature($0) } }

		while Date() < deadline {
			usleep(200_000)
			guard let current = try? Snapshot.capture(target, fullTree: false) else { continue }
			let currentText = current.lines.joined(separator: "\n")

			switch until {
			case "text_appears":
				guard let text, !text.isEmpty else {
					throw HelperError("badArguments", "text_appears 需要 text", retryable: false)
				}
				if currentText.localizedCaseInsensitiveContains(text) {
					return ok(until, started, ["matched": text])
				}
			case "text_gone":
				guard let text, !text.isEmpty else {
					throw HelperError("badArguments", "text_gone 需要 text", retryable: false)
				}
				if !currentText.localizedCaseInsensitiveContains(text) {
					return ok(until, started, ["matched": text])
				}
			case "element_changes":
				guard let elementNumber, let baseline = baselineElement else {
					throw HelperError("badArguments", "element_changes 需要 elementNumber，且该编号要在当前快照里", retryable: false)
				}
				if let element = current.elements[elementNumber], signature(element) != baseline {
					return ok(until, started, ["elementNumber": elementNumber])
				}
			case "new_window":
				let count = windowCount(target)
				if count > baselineWindows {
					return ok(until, started, ["windows": count, "before": baselineWindows])
				}
			case "any_change":
				if currentText != baselineText {
					return ok(until, started)
				}
			case "settled":
				// 连续两次快照一致 = 界面稳定下来了
				if currentText == previous.lines.joined(separator: "\n") {
					return ok(until, started)
				}
			default:
				throw HelperError(
					"badArguments",
					"不认识的等待条件：\(until)（可用 text_appears / text_gone / element_changes / new_window / settled / any_change）",
					retryable: false
				)
			}
			previous = current
		}

		throw HelperError(
			"timedOut",
			"等了 \(timeoutMs / 1000) 秒，界面没有变成「\(until)」\(text.map { "（\($0)）" } ?? "")。可以先 observe 看看现在是什么状态",
			retryable: true
		)
	}

	/// 客户端 deadline 可能已过期（客户端会先超时），留 1 秒余量回包
	private static func deadlineLimit(_ deadline: Date, fallback: Date) -> Date {
		let limit = deadline.addingTimeInterval(-1)
		return limit > Date() ? limit : fallback
	}

	private static func ok(_ until: String, _ started: Date, _ extra: [String: Any] = [:]) -> [String: Any] {
		var result: [String: Any] = [
			"ok": true,
			"until": until,
			"waitedMs": Int(Date().timeIntervalSince(started) * 1000),
		]
		for (key, value) in extra { result[key] = value }
		return result
	}

	private static func windowCount(_ target: TargetApp) -> Int {
		(Snapshot.attribute(target.element, kAXWindowsAttribute) as? [AXUIElement])?.count ?? 0
	}

	/// 元素的关键状态签名：值、标题、是否可用
	private static func signature(_ element: AXUIElement) -> String {
		[
			Snapshot.string(element, kAXValueAttribute) ?? "",
			Snapshot.string(element, kAXTitleAttribute) ?? "",
			(Snapshot.attribute(element, kAXEnabledAttribute) as? Bool).map(String.init) ?? "",
			(Snapshot.attribute(element, kAXFocusedAttribute) as? Bool).map(String.init) ?? "",
		].joined(separator: "|")
	}
}
