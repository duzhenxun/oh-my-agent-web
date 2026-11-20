import ApplicationServices
import Darwin

/// 取 AX 窗口对应的 CGWindowID（截图要用）。
///
/// `_AXUIElementGetWindow` 是私有符号：用 dlsym 动态取，取不到就返回 nil —— 只是截不了图，
/// 元素树和点击照常工作。硬链接私有符号会在系统改名时直接崩，不值得。
enum WindowNumber {
	private typealias GetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

	private static let function: GetWindowFn? = {
		guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
		return unsafeBitCast(symbol, to: GetWindowFn.self)
	}()

	static func of(_ element: AXUIElement) -> CGWindowID? {
		guard let function else { return nil }
		var id: CGWindowID = 0
		return function(element, &id) == .success && id != 0 ? id : nil
	}
}
