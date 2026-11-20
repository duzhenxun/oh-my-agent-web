import AppKit

/// agent 的指针动画：让用户看见「它现在要点哪里」。
///
/// 为什么需要：agent 通过 AX/CGEvent 操作时，系统光标可能只是「瞬移」一下，
/// 用户完全不知道发生了什么。这里画一个独立的指示器，跟着真实光标走、点击时放大一下。
///
/// 实现要点：
///   - 覆盖全屏的透明窗口，`ignoresMouseEvents = true`（绝不能挡住真实点击）；
///   - `.statusBar` 层级，压在最上面；`canJoinAllSpaces` 让它跨屏可见；
///   - 用 Core Animation 移动/缩放，避免 60fps 手工重绘。
final class PointerOverlay {
	static let shared = PointerOverlay()

	private var window: NSWindow?
	private var dot: NSView?
	private var ring: NSView?
	private var followTimer: Timer?
	private var hideWork: DispatchWorkItem?

	/// 显示并跟随光标（幂等：重复调用不会叠出多个窗口）
	func show() {
		guard HelperSettings.current.pointerEnabled else { return }
		DispatchQueue.main.async { [weak self] in
			guard let self else { return }
			let window = self.makeWindowIfNeeded()
			window.orderFrontRegardless()
			self.startFollowing()
			self.scheduleHide()
		}
	}

	/// 点击动画：光圈放大 + 淡出，标出「刚才点了这里」
	func pulse(at point: CGPoint? = nil) {
		guard HelperSettings.current.pointerEnabled else { return }
		DispatchQueue.main.async { [weak self] in
			guard let self, let ring = self.ring, self.window?.isVisible == true else { return }
			if let point { self.move(to: point) }
			self.scheduleHide()

			ring.layer?.removeAllAnimations()
			ring.isHidden = false
			ring.layer?.opacity = 1

			let scale = CABasicAnimation(keyPath: "transform.scale")
			scale.fromValue = 0.6
			scale.toValue = 1.9
			let fade = CABasicAnimation(keyPath: "opacity")
			fade.fromValue = 0.9
			fade.toValue = 0
			let group = CAAnimationGroup()
			group.animations = [scale, fade]
			group.duration = 0.45 / max(0.25, HelperSettings.current.pointerSpeed)
			group.timingFunction = CAMediaTimingFunction(name: .easeOut)
			ring.layer?.add(group, forKey: "pulse")
		}
	}

	/// 移动到某个屏幕坐标（动作发生前调用，用户能提前看到目标点）
	func move(to point: CGPoint) {
		guard HelperSettings.current.pointerEnabled else { return }
		DispatchQueue.main.async { [weak self] in
			guard let self, let window = self.window else { return }
			// 窗口坐标是左下原点：把全局（左上原点）坐标换过来
			guard let screen = NSScreen.screens.first(where: { $0.frame.contains(point) }) ?? NSScreen.main else { return }
			let local = NSPoint(
				x: point.x - screen.frame.minX,
				y: screen.frame.maxY - point.y
			)
			window.setFrameOrigin(NSPoint(x: screen.frame.minX, y: screen.frame.minY))
			if window.frame.size != screen.frame.size {
				window.setContentSize(screen.frame.size)
			}
			CATransaction.begin()
			CATransaction.setAnimationDuration(0.18 / max(0.25, HelperSettings.current.pointerSpeed))
			self.dot?.layer?.position = local
			self.ring?.layer?.position = local
			CATransaction.commit()
			self.scheduleHide()
		}
	}

	func hide() {
		DispatchQueue.main.async { [weak self] in
			guard let self else { return }
			self.followTimer?.invalidate()
			self.followTimer = nil
			self.window?.orderOut(nil)
		}
	}

	// MARK: - 内部

	/// 跟随真实光标：我们自己的 CGEvent 移动也会改光标位置，所以只要跟住光标就对了
	private func startFollowing() {
		guard followTimer == nil else { return }
		followTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
			guard let self, self.window?.isVisible == true else { return }
			if !HelperSettings.current.pointerEnabled {
				self.hide()
				return
			}
			self.followCursor()
		}
	}

	private func followCursor() {
		guard let window, let dot, let ring else { return }
		let point = NSEvent.mouseLocation // 已经是「左下原点」的屏幕坐标
		let screen = window.screen ?? NSScreen.main
		guard let screen else { return }
		let local = NSPoint(x: point.x - screen.frame.minX, y: point.y - screen.frame.minY)
		CATransaction.begin()
		CATransaction.setAnimationDuration(0.08)
		dot.layer?.position = local
		ring.layer?.position = local
		CATransaction.commit()
	}

	/// 动作结束后过一会儿自动隐藏，别一直占着屏幕
	private func scheduleHide() {
		hideWork?.cancel()
		let work = DispatchWorkItem { [weak self] in self?.hide() }
		hideWork = work
		DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: work)
	}

	private func makeWindowIfNeeded() -> NSWindow {
		if let window { return window }
		let screen = NSScreen.main
		let frame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
		let window = NSWindow(
			contentRect: frame,
			styleMask: [.borderless],
			backing: .buffered,
			defer: false
		)
		window.isOpaque = false
		window.backgroundColor = .clear
		window.hasShadow = false
		window.level = .statusBar
		window.ignoresMouseEvents = true
		window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
		window.isMovable = false

		let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
		content.wantsLayer = true

		let ring = NSView(frame: NSRect(x: 0, y: 0, width: 44, height: 44))
		ring.wantsLayer = true
		ring.layer?.cornerRadius = 22
		ring.layer?.borderWidth = 2
		ring.layer?.borderColor = NSColor.systemBlue.withAlphaComponent(0.9).cgColor
		ring.layer?.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.12).cgColor
		ring.layer?.isHidden = true

		let dot = NSView(frame: NSRect(x: 0, y: 0, width: 14, height: 14))
		dot.wantsLayer = true
		dot.layer?.cornerRadius = 7
		dot.layer?.backgroundColor = NSColor.systemBlue.cgColor
		dot.layer?.borderWidth = 2
		dot.layer?.borderColor = NSColor.white.withAlphaComponent(0.9).cgColor
		dot.layer?.shadowColor = NSColor.black.cgColor
		dot.layer?.shadowOpacity = 0.25
		dot.layer?.shadowRadius = 3
		dot.layer?.shadowOffset = CGSize(width: 0, height: -1)

		content.addSubview(ring)
		content.addSubview(dot)
		window.contentView = content

		self.window = window
		self.dot = dot
		self.ring = ring
		return window
	}
}
