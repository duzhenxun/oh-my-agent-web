import AppKit
import CoreGraphics
import ScreenCaptureKit

/// 窗口截图：给 agent 看「界面上画了什么」，坐标点击也以这张图为准。
///
/// 两条路：
///   ① ScreenCaptureKit（macOS 14+）：新系统上 CGWindowListCreateImage 可能返回空白，优先走这条；
///   ② CGWindowListCreateImage：老系统回退。
/// 没有屏幕录制权限时返回 nil，元素树照常可用（只是没有图）。
enum Screenshot {
	static func capture(_ snapshot: Snapshot, windowNumber: CGWindowID) -> [String: Any]? {
		guard Permissions.screenRecordingGranted() else { return nil }

		// 三条路，从准到糙：
		//   ① SCK 按窗口截（最干净，只拍目标窗口）
		//   ② CGWindowList 按窗口截（老系统）
		//   ③ 截主屏再按窗口区域裁剪 —— 不依赖私有 windowID，新系统上最可靠
		var image: CGImage?
		if windowNumber != 0 {
			image = captureModern(windowNumber) ?? captureLegacy(windowNumber)
		}
		if image == nil {
			image = captureScreenRegion(snapshot)
		}
		guard let image, image.width > 0, image.height > 0 else { return nil }

		let rep = NSBitmapImageRep(cgImage: image)
		guard let png = rep.representation(using: .png, properties: [:]) else { return nil }

		let dir = FileManager.default.homeDirectoryForCurrentUser
			.appendingPathComponent("Library/Application Support/AgentComputer/screenshots")
		try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		// 只留最近 12 张，避免长期运行把磁盘塞满
		prune(dir)
		let file = dir.appendingPathComponent("\(snapshot.generation).png")
		do {
			try png.write(to: file)
		} catch {
			Log.write("写截图失败：\(error.localizedDescription)")
			return nil
		}
		return [
			"path": file.path,
			"width": Int(image.width),
			"height": Int(image.height),
		]
	}

	// MARK: - ScreenCaptureKit

	private static func captureModern(_ windowNumber: CGWindowID) -> CGImage? {
		guard #available(macOS 14.0, *) else { return nil }
		let semaphore = DispatchSemaphore(value: 0)
		var result: CGImage?
		Task.detached {
			do {
				let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
				guard let window = content.windows.first(where: { $0.windowID == windowNumber }) else {
					semaphore.signal()
					return
				}
				let filter = SCContentFilter(desktopIndependentWindow: window)
				let configuration = SCStreamConfiguration()
				configuration.width = Int(window.frame.width * 2)
				configuration.height = Int(window.frame.height * 2)
				configuration.showsCursor = false
				configuration.ignoreShadowsSingleWindow = true
				result = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
			} catch {
				Log.write("ScreenCaptureKit 截图失败，回退 CG：\(error.localizedDescription)")
			}
			semaphore.signal()
		}
		_ = semaphore.wait(timeout: .now() + 4)
		return result
	}

	// MARK: - CoreGraphics（老系统 / SCK 拿不到时）

	private static func captureLegacy(_ windowNumber: CGWindowID) -> CGImage? {
		CGWindowListCreateImage(
			.null,
			.optionIncludingWindow,
			windowNumber,
			[.boundsIgnoreFraming, .bestResolution]
		)
	}

	/// 截主屏然后按窗口的 AX 区域裁剪。
	///
	/// 为什么需要：`_AXUIElementGetWindow` 是私有符号，新系统上可能拿不到窗口号，
	/// 那条路径会直接返回 nil。裁剪法只依赖「窗口在屏幕上的位置」，稳得多。
	/// 只处理主屏（原点 0,0）：副屏的坐标换算在多显示器 + 不同缩放时容易错。
	private static func captureScreenRegion(_ snapshot: Snapshot) -> CGImage? {
		guard let screen = NSScreen.screens.first, screen.frame.minX == 0, screen.frame.minY == 0 else { return nil }
		guard snapshot.windowSize.width > 0, snapshot.windowSize.height > 0 else { return nil }
		guard let full = CGWindowListCreateImage(
			CGRect(origin: .zero, size: screen.frame.size),
			.optionOnScreenOnly,
			kCGNullWindowID,
			[.bestResolution]
		) else { return nil }

		let scale = CGFloat(full.width) / screen.frame.width
		// AX 坐标是「左上原点」，CG 图像也是左上原点，直接乘缩放即可
		let rect = CGRect(
			x: snapshot.windowOrigin.x * scale,
			y: snapshot.windowOrigin.y * scale,
			width: snapshot.windowSize.width * scale,
			height: snapshot.windowSize.height * scale
		).intersection(CGRect(x: 0, y: 0, width: full.width, height: full.height))
		guard rect.width > 8, rect.height > 8 else { return nil }
		return full.cropping(to: rect.integral)
	}

	private static func prune(_ dir: URL) {
		guard let files = try? FileManager.default.contentsOfDirectory(
			at: dir,
			includingPropertiesForKeys: [.contentModificationDateKey],
			options: [.skipsHiddenFiles]
		) else { return }
		let sorted = files.sorted {
			let left = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
			let right = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
			return left > right
		}
		for file in sorted.dropFirst(12) {
			try? FileManager.default.removeItem(at: file)
		}
	}
}
