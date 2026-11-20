#!/usr/bin/env swift
/**
 * 尝试在「系统设置 → 隐私与安全性」里替用户勾上本 app。
 *
 *   swift scripts/auto-grant.swift accessibility
 *   swift scripts/auto-grant.swift screencapture
 *
 * 说明：macOS 不提供「自己给自己授权」的 API，这里只是**代点界面**。
 * 如果系统弹出认证框（密码 / Touch ID），仍然需要用户本人确认 —— 这是设计如此。
 * 所以脚本的结果分三种：已勾上、需要用户确认、找不到条目。
 */
import AppKit
import ApplicationServices

let which = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "accessibility"
let targetName = "Agent Computer"
let pane = which == "screencapture"
	? "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
	: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"

guard AXIsProcessTrusted() else {
	print("need-access: 当前终端没有辅助功能权限，没法代替点击")
	exit(2)
}

if let url = URL(string: pane) {
	NSWorkspace.shared.open(url)
}
// 等系统设置窗口完成渲染
usleep(2_500_000)

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
	var value: CFTypeRef?
	guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
	return value
}

func text(_ element: AXUIElement, _ name: String) -> String? {
	guard let value = attribute(element, name) else { return nil }
	if let string = value as? String { return string }
	if let number = value as? NSNumber { return number.stringValue }
	return nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
	(attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

/// 广度优先找「标题/描述含目标名」的复选框
func findCheckbox(under root: AXUIElement, limit: Int = 4000) -> AXUIElement? {
	var queue: [AXUIElement] = [root]
	var visited = 0
	while !queue.isEmpty, visited < limit {
		let element = queue.removeFirst()
		visited += 1
		let role = text(element, kAXRoleAttribute) ?? ""
		let title = text(element, kAXTitleAttribute) ?? ""
		let desc = text(element, kAXDescriptionAttribute) ?? ""
		let help = text(element, kAXHelpAttribute) ?? ""
		let haystack = "\(title) \(desc) \(help)"
		if role == (kAXCheckBoxRole as String), haystack.contains(targetName) {
			return element
		}
		// 行容器常常不是 checkbox 本身：把整行里的 checkbox 找出来
		if haystack.contains(targetName) {
			for child in children(element) where (text(child, kAXRoleAttribute) ?? "") == (kAXCheckBoxRole as String) {
				return child
			}
		}
		queue.append(contentsOf: children(element))
	}
	return nil
}

guard let settings = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first else {
	print("no-settings: 系统设置没有启动")
	exit(3)
}

let appElement = AXUIElementCreateApplication(settings.processIdentifier)
guard let checkbox = findCheckbox(under: appElement) else {
	print("no-row: 列表里还没有「\(targetName)」，先让 app 请求一次权限（打开 app 即可）")
	exit(4)
}

let current = (attribute(checkbox, kAXValueAttribute) as? NSNumber)?.intValue ?? 0
if current == 1 {
	print("already: 已经勾上了")
	exit(0)
}

let pressed = AXUIElementPerformAction(checkbox, kAXPressAction as CFString)
if pressed != .success {
	print("press-failed: AXError \(pressed.rawValue)")
	exit(5)
}
usleep(600_000)

let after = (attribute(checkbox, kAXValueAttribute) as? NSNumber)?.intValue ?? 0
if after == 1 {
	print("granted: 已勾上「\(targetName)」")
	exit(0)
}
print("needs-confirm: 已点，但系统还在等你确认（密码 / Touch ID）")
exit(6)
