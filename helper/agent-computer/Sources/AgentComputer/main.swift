import AppKit
import Darwin
import Foundation

/// 可安装的 Agent Computer 兼容 helper。
///
/// 传输：Unix socket + `uint32 小端长度 + UTF-8 JSON` 帧 + JSON-RPC（hello / request）。
/// 能力：findApps、observeApp（编号元素树 + 截图）、act（点击 / 输入 / 赋值 / 快捷键 /
///       粘贴 / 滚动 / 拖拽 / 任意无障碍动作 / 菜单命令）、appCommands、waitFor、previewPanel。
///
/// 线程模型：
///   主线程跑 NSApplication（浮窗、剪贴板都要 runloop）；
///   socket 服务在后台线程 accept，每个连接一个线程；
///   所有请求在 Protocol 的串行队列里执行，保证不会同时动鼠标。

/// socket 路径：与 oh-my-agent-web 的 `server/computer/paths.ts` 保持一致
func socketPath() -> String {
	if let override = ProcessInfo.processInfo.environment["CUT_SOCKET_PATH"]?.trimmingCharacters(in: .whitespaces),
		!override.isEmpty {
		return override
	}
	return NSHomeDirectory() + "/Library/Application Support/AgentComputer/agent-computer.sock"
}

final class SocketServer {
	private let path: String
	private var listenFD: Int32 = -1

	init(path: String) {
		self.path = path
	}

	func run() throws {
		LegacyMigration.run()
		let dir = (path as NSString).deletingLastPathComponent
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
		unlink(path)

		listenFD = socket(AF_UNIX, SOCK_STREAM, 0)
		guard listenFD >= 0 else { throw HelperError("helperFault", "建 socket 失败：\(errno)") }

		var address = sockaddr_un()
		address.sun_family = sa_family_t(AF_UNIX)
		let capacity = MemoryLayout.size(ofValue: address.sun_path)
		guard path.utf8.count < capacity else {
			throw HelperError("helperFault", "socket 路径太长：\(path)")
		}
		_ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
			pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { destination in
				path.withCString { source in strncpy(destination, source, capacity - 1) }
			}
		}

		let bound = withUnsafePointer(to: &address) { pointer in
			pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
				bind(listenFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
			}
		}
		guard bound == 0 else { throw HelperError("helperFault", "bind 失败：\(errno)") }
		guard listen(listenFD, 16) == 0 else { throw HelperError("helperFault", "listen 失败：\(errno)") }
		// 只允许本人读写：socket 能点任何 App，不能给同机其他用户
		chmod(path, 0o600)

		Log.write("helper 已启动 pid=\(ProcessInfo.processInfo.processIdentifier) socket=\(path)")

		while true {
			let client = accept(listenFD, nil, nil)
			if client < 0 {
				if errno == EINTR { continue }
				Log.write("accept 失败：\(errno)")
				usleep(200_000)
				continue
			}
			// 不要在已关闭的连接上 SIGPIPE 把整个 helper 打死
			var on: Int32 = 1
			setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))

			let thread = Thread { self.serve(client) }
			thread.stackSize = 1 << 20
			thread.start()
		}
	}

	private func serve(_ fd: Int32) {
		defer { close(fd) }
		let decoder = Framing.Decoder()
		var buffer = [UInt8](repeating: 0, count: 64 * 1024)

		while true {
			let read = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
			if read == 0 { return }
			if read < 0 {
				if errno == EINTR { continue }
				return
			}
			let chunk = Data(buffer[0..<read])
			do {
				for frame in try decoder.push(chunk) {
					let method = frame["method"] as? String ?? ""
					let id = frame["id"] ?? NSNull()
					let params = frame["params"] as? [String: Any] ?? [:]
					let reply = Protocol.handle(method: method, params: params, id: id)
					try writeAll(fd, data: Framing.encode(reply))
				}
			} catch {
				Log.write("协议错误，断开连接：\(error)")
				return
			}
		}
	}

	private func writeAll(_ fd: Int32, data: Data) throws {
		var offset = 0
		while offset < data.count {
			let written = data.withUnsafeBytes { raw -> Int in
				Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
			}
			if written <= 0 {
				if errno == EINTR { continue }
				throw HelperError("helperFault", "写回失败：\(errno)")
			}
			offset += written
		}
	}
}

/// 退出时删掉 socket 文件，否则下次启动会连到一个死 socket
func cleanup() {
	unlink(socketPath())
}

let signalHandler: @convention(c) (Int32) -> Void = { _ in
	cleanup()
	exit(0)
}

// 后端写已断开的 socket 时不能因为 SIGPIPE 直接死掉
signal(SIGPIPE, SIG_IGN)
signal(SIGINT, signalHandler)
signal(SIGTERM, signalHandler)
atexit { cleanup() }

final class AppDelegate: NSObject, NSApplicationDelegate {
	/// 菜单栏入口要在启动时创建，否则用户授权完就找不到这个 app 了
	private var statusMenu: StatusMenu?

	func applicationDidFinishLaunching(_ notification: Notification) {
		statusMenu = StatusMenu()
		// 没授权时弹引导（含系统权限提示），已授权就安静地待在菜单栏
		Onboarding.shared.showIfNeeded()

		let thread = Thread {
			do {
				try SocketServer(path: socketPath()).run()
			} catch let error as HelperError {
				Log.write("启动失败：\(error.name) \(error.message)")
				exit(1)
			} catch {
				Log.write("启动失败：\(error)")
				exit(1)
			}
		}
		thread.stackSize = 1 << 20
		thread.start()
	}

	/// 双击 .app（或在 Finder 里「打开」）时走到这里。
	///
	/// 后台 app 没有 Dock 图标，默认「没有任何反应」；这里主动把引导窗口叫出来，
	/// 用户才知道自己点到的是个正在运行的助手，而不是双击失败。
	func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
		Onboarding.shared.show()
		return true
	}
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
// 后台服务：不占 Dock，也不需要菜单栏
application.setActivationPolicy(.accessory)
application.run()
