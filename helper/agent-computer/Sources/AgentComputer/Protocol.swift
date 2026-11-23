import AppKit
import Foundation

/// JSON-RPC 分发：`hello` 握手 + `request` 业务请求。
///
/// 一次 observe 得到的编号只在「最近一次快照」里有效；每个动作都先确认编号还在，
/// 避免拿着旧编号点到完全不同的东西。
enum Protocol {
	static let apiVersion = "agent-computer-1"
	/// 版本号只认 `Info.plist` 的 `CFBundleShortVersionString`。
	///
	/// 以前这里写死了一个字符串，改 plist 不改这儿的话，面板显示的版本就永远停在旧值
	/// （0.3.1 那次就踩了：plist 已经 0.3.1，`hello` 还报 0.3.0）。
	/// 直接跑二进制（不在 .app 里）时读不到 infoDictionary，回退成 `dev`。
	static let helperVersion =
		(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"

	/// 所有请求串行执行：多连接并发操作会互相抢鼠标/焦点
	private static let queue = DispatchQueue(label: "com.computeruseturbo.minhelper.protocol")
	/// 超过这个时间还没处理完，就放弃等待并如实报错（卡住的通常是系统模态框）
	private static let watchdogSeconds = 150

	static func handle(method: String, params: [String: Any], id: Any) -> [String: Any] {
		// 用 semaphore 而不是 queue.sync：某个调用卡住时不能让后面的探活请求全部排死
		let semaphore = DispatchSemaphore(value: 0)
		var reply: [String: Any] = HelperError("timedOut", "helper 正忙，请稍后再试", retryable: true).asJSON(id: id)
		queue.async {
			reply = execute(method: method, params: params, id: id)
			semaphore.signal()
		}
		if semaphore.wait(timeout: .now() + .seconds(watchdogSeconds)) == .timedOut {
			Log.write("请求超时（\(watchdogSeconds)s）：\(method)")
			return HelperError(
				"timedOut",
				"这次操作 \(watchdogSeconds) 秒还没完成（可能卡在系统对话框上），先看界面再重试",
				retryable: true
			).asJSON(id: id)
		}
		return reply
	}

	private static func execute(method: String, params: [String: Any], id: Any) -> [String: Any] {
		do {
			switch method {
			case "hello":
				return try hello(params: params, id: id)
			case "request":
				return try request(params: params, id: id)
			default:
				throw HelperError("noSuchMethod", "不认识的方法：\(method)", retryable: false)
			}
		} catch let error as HelperError {
			Log.write("\(method) 失败：\(error.name) \(error.message)")
			return error.asJSON(id: id)
		} catch {
			Log.write("\(method) 异常：\(error)")
			return HelperError("helperFault", "\(error)").asJSON(id: id)
		}
	}

	private static func hello(params: [String: Any], id: Any) throws -> [String: Any] {
		let clientVersion = params["clientApiVersion"] as? String ?? ""
		guard clientVersion == apiVersion else {
			throw HelperError(
				"protocolMismatch",
				"客户端 API 版本是 \(clientVersion)，本 helper 只支持 \(apiVersion)",
				retryable: false
			)
		}
		return [
			"jsonrpc": "2.0",
			"id": id,
			"result": [
				"serverApiVersion": apiVersion,
				"helperVersion": helperVersion,
				"pid": Int(ProcessInfo.processInfo.processIdentifier),
				"permissions": Permissions.snapshot(),
			],
		]
	}

	private static func request(params: [String: Any], id: Any) throws -> [String: Any] {
		let type = params["requestType"] as? String ?? ""
		let payload = params["payload"] as? [String: Any] ?? [:]
		let result = try dispatch(type: type, payload: payload, deadline: deadlineOf(params))
		return ["jsonrpc": "2.0", "id": id, "result": result]
	}

	/// 客户端给的截止时间（毫秒时间戳）；没有就当作 120 秒后
	private static func deadlineOf(_ params: [String: Any]) -> Date {
		if let millis = params["deadlineUnixMillis"] as? Double {
			return Date(timeIntervalSince1970: millis / 1000)
		}
		if let millis = params["deadlineUnixMillis"] as? Int {
			return Date(timeIntervalSince1970: Double(millis) / 1000)
		}
		return Date().addingTimeInterval(120)
	}

	private static func dispatch(type: String, payload: [String: Any], deadline: Date) throws -> [String: Any] {
		switch type {
		case "findApps":
			let apps = AppLookup.actionableApps().map { app in
				[
					"name": app.localizedName ?? "",
					"bundleId": app.bundleIdentifier ?? "",
					"pid": Int(app.processIdentifier),
					"active": app.isActive,
				] as [String: Any]
			}
			return ["apps": apps]

		case "accessStatus":
			return Permissions.snapshot()

		case "requestAccess":
			return [
				"accessibility": Permissions.requestAccessibility(),
				"screenRecording": Permissions.requestScreenRecording(),
			]

		case "observeApp":
			return try observe(payload: payload)

		case "act":
			return try act(payload: payload)

		case "appCommands":
			return Menu.commands(try target(payload))

		case "waitFor":
			return try Waiter.wait(try target(payload), payload: payload, deadline: deadline)

		case "previewPanel":
			Preview.show(payload["show"] as? Bool ?? false)
			return ["ok": true, "show": payload["show"] as? Bool ?? false]

		// 设置文件被面板改过：下一次用到时重新读（无需重启 helper）
		case "settingsChanged":
			HelperSettings.invalidate()
			Preview.syncWithSettings()
			return ["ok": true, "preview": HelperSettings.current.previewEnabled, "pointer": HelperSettings.current.pointerEnabled]

		case "finishTurn":
			Actions.setSnapshot(nil)
			AgentHUD.finish()
			return ["ok": true]

		default:
			throw HelperError("noSuchMethod", "不支持的 requestType：\(type)", retryable: false)
		}
	}

	private static func target(_ payload: [String: Any]) throws -> TargetApp {
		guard let appName = payload["app"] as? String, !appName.isEmpty else {
			throw HelperError("badArguments", "缺少 app（应用名）", retryable: false)
		}
		return try AppLookup.require(appName)
	}

	// MARK: - observeApp

	private static func observe(payload: [String: Any]) throws -> [String: Any] {
		let target = try self.target(payload)
		let fullTree = payload["fullTree"] as? Bool ?? false
		let snapshot = try Snapshot.capture(target, fullTree: fullTree, preferredWindow: payload["window"] as? String)
		Actions.setSnapshot(snapshot)

		var result: [String: Any] = [
			"app": target.info,
			"generation": snapshot.generation,
			"elementCount": snapshot.elements.count,
			"text": snapshot.lines.joined(separator: "\n"),
		]

		// 面板里勾了「显示实时预览浮窗」，observe 完就让它出现并写明在看哪个应用
		AgentHUD.watching(app: target.name)

		if payload["includeScreenshot"] as? Bool ?? false {
			if let shot = Screenshot.capture(snapshot, windowNumber: snapshot.windowNumber) {
				// 先按图宽校准 Retina 缩放，再把 scale 一起返回（坐标点击要用它）
				snapshot.calibrateScale(imageWidth: shot["width"] as? Int ?? 0)
				var withScale = shot
				withScale["scale"] = snapshot.scale
				result["screenshot"] = withScale
				if let path = shot["path"] as? String { Preview.refresh(path: path) }
			} else {
				let reason = Permissions.screenRecordingGranted()
					? "这个窗口截不到（可能被系统保护）"
					: "没有屏幕录制权限：到 系统设置 → 隐私与安全性 → 屏幕录制 里勾上 Agent Computer"
				Preview.refresh(path: nil, reason: reason)
				result["screenshot"] = ["error": reason]
			}
		}
		return result
	}

	// MARK: - act

	private static func act(payload: [String: Any]) throws -> [String: Any] {
		let target = try self.target(payload)
		guard let step = payload["step"] as? [String: Any], let kind = step["type"] as? String else {
			throw HelperError("badArguments", "act 需要 step.type", retryable: false)
		}
		switch kind {
		case "clickAt": return try Actions.click(target, step: step)
		case "writeText": return try Actions.writeText(target, step: step)
		case "fillValue": return try Actions.fill(target, step: step)
		case "sendKeys", "pressKeys": return try Actions.sendKeys(target, step: step)
		case "pasteText": return try Actions.pasteText(target, step: step)
		case "scrollView": return try Actions.scroll(target, step: step)
		case "dragItem": return try Actions.drag(target, step: step)
		case "invokeAction": return try Actions.invoke(target, step: step)
		case "runCommand":
			guard let path = step["path"] as? [String], !path.isEmpty else {
				throw HelperError("badArguments", "runCommand 需要 path 数组", retryable: false)
			}
			return try Menu.run(target, path: path)
		default:
			throw HelperError("notSupported", "不支持的动作 \(kind)", retryable: false)
		}
	}
}
