import AppKit
import ApplicationServices

/// 一个正在运行的应用 + 它的无障碍入口。
struct TargetApp {
	let app: NSRunningApplication
	let element: AXUIElement

	var name: String { app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)" }

	var info: [String: Any] {
		[
			"name": name,
			"bundleId": app.bundleIdentifier ?? "",
			"pid": Int(app.processIdentifier),
			"active": app.isActive,
		]
	}
}

enum AppLookup {
	/// 可操作的应用：排除后台/仅辅助的应用（Dock、控制中心之类拿不到窗口，列出来只会干扰）。
	static func actionableApps() -> [NSRunningApplication] {
		NSWorkspace.shared.runningApplications
			.filter { $0.activationPolicy == .regular && $0.processIdentifier > 0 }
			.sorted { ($0.isActive ? 0 : 1, $0.localizedName ?? "") < ($1.isActive ? 0 : 1, $1.localizedName ?? "") }
	}

	/// 按名字 / bundle id 找应用：先精确，再忽略大小写，最后唯一前缀匹配。
	static func find(_ query: String) -> TargetApp? {
		let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return nil }
		let apps = actionableApps()
		let needle = trimmed.lowercased()

		func match(_ app: NSRunningApplication) -> Bool {
			let name = (app.localizedName ?? "").lowercased()
			let bundle = (app.bundleIdentifier ?? "").lowercased()
			return name == needle || bundle == needle || name.hasPrefix(needle) || bundle.hasSuffix(".\(needle)")
		}

		guard let app = apps.first(where: match) ?? apps.first(where: {
			($0.localizedName ?? "").lowercased().contains(needle)
		}) else {
			return nil
		}
		return TargetApp(app: app, element: AXUIElementCreateApplication(app.processIdentifier))
	}

	static func require(_ query: String) throws -> TargetApp {
		guard Permissions.accessibilityGranted() else {
			throw HelperError(
				"accessMissing",
				"helper 还没有「辅助功能」权限：到 系统设置 → 隐私与安全性 → 辅助功能 里勾上 Agent Computer",
				retryable: false
			)
		}
		guard let target = find(query) else {
			throw HelperError("appMissing", "没有找到应用「\(query)」，先用 findApps 看看有哪些", retryable: false)
		}
		return target
	}
}
