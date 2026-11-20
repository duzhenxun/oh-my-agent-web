#!/usr/bin/env swift
/**
 * 生成 .icns 应用图标（纯 AppKit 绘制，不依赖外部素材）。
 *
 *   swift scripts/make-icon.swift Resources/AppIcon.icns
 *
 * 设计：蓝紫渐变圆角矩形（macOS 图标比例）+ 白色光标与瞄准环。
 * 用 SF Symbol 渲染前景，避免手绘路径在不同尺寸下变形。
 */
import AppKit
import Foundation

let output = CommandLine.arguments.count > 1
	? CommandLine.arguments[1]
	: "Resources/AppIcon.icns"

/// macOS 图标：1024 画布，图形区域 824×824 居中，圆角半径约为边长的 22.5%
let canvas: CGFloat = 1024
let inset: CGFloat = 100
let rect = NSRect(x: inset, y: inset, width: canvas - inset * 2, height: canvas - inset * 2)
let radius = rect.width * 0.225

func drawIcon(size: CGFloat) -> NSImage {
	let image = NSImage(size: NSSize(width: size, height: size))
	image.lockFocus()
	defer { image.unlockFocus() }

	let scale = size / canvas
	NSGraphicsContext.current?.imageInterpolation = .high

	// 底：圆角矩形 + 斜向渐变
	let path = NSBezierPath(roundedRect: rect.insetBy(dx: 0, dy: 0), xRadius: radius, yRadius: radius)
	let gradient = NSGradient(colors: [
		NSColor(srgbRed: 0.30, green: 0.48, blue: 0.95, alpha: 1),
		NSColor(srgbRed: 0.55, green: 0.32, blue: 0.92, alpha: 1),
	])
	gradient?.draw(in: path, angle: -70)

	// 顶部一层浅光，避免大面积纯色显得扁平
	NSGraphicsContext.saveGraphicsState()
	path.addClip()
	let sheen = NSGradient(colors: [
		NSColor(white: 1, alpha: 0.20),
		NSColor(white: 1, alpha: 0),
	])
	sheen?.draw(in: NSRect(x: rect.minX, y: rect.midY, width: rect.width, height: rect.height / 2), angle: -90)
	NSGraphicsContext.restoreGraphicsState()

	// 前景：光标 + 波纹（指向「操作界面」）
	if let symbol = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: nil) {
		let config = NSImage.SymbolConfiguration(pointSize: rect.width * 0.52, weight: .semibold)
		if let configured = symbol.withSymbolConfiguration(config) {
			// 转成纯白：画完用 sourceAtop 填一次白色
			let tinted = NSImage(size: configured.size)
			tinted.lockFocus()
			configured.draw(in: NSRect(origin: .zero, size: configured.size))
			NSColor.white.setFill()
			NSRect(origin: .zero, size: configured.size).fill(using: .sourceAtop)
			tinted.unlockFocus()

			let target = NSRect(
				x: (size - configured.size.width) / 2,
				y: (size - configured.size.height) / 2,
				width: configured.size.width,
				height: configured.size.height
			)
			tinted.draw(in: target, from: .zero, operation: .sourceOver, fraction: 0.97)
		}
	}

	_ = scale
	return image
}

func png(_ image: NSImage, size: Int) -> Data? {
	let rep = NSBitmapImageRep(
		bitmapDataPlanes: nil,
		pixelsWide: size,
		pixelsHigh: size,
		bitsPerSample: 8,
		samplesPerPixel: 4,
		hasAlpha: true,
		isPlanar: false,
		colorSpaceName: .deviceRGB,
		bytesPerRow: 0,
		bitsPerPixel: 0
	)
	guard let rep else { return nil }
	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
	image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
	NSGraphicsContext.restoreGraphicsState()
	return rep.representation(using: .png, properties: [:])
}

// 生成 iconset（@1x / @2x 成对）
let iconset = FileManager.default.temporaryDirectory
	.appendingPathComponent("AppIcon-\(UUID().uuidString).iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: iconset) }

let master = drawIcon(size: canvas)
let sizes: [(name: String, pixels: Int)] = [
	("icon_16x16", 16), ("icon_16x16@2x", 32),
	("icon_32x32", 32), ("icon_32x32@2x", 64),
	("icon_128x128", 128), ("icon_128x128@2x", 256),
	("icon_256x256", 256), ("icon_256x256@2x", 512),
	("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for entry in sizes {
	guard let data = png(master, size: entry.pixels) else {
		FileHandle.standardError.write(Data("生成 \(entry.name) 失败\n".utf8))
		exit(1)
	}
	try data.write(to: iconset.appendingPathComponent("\(entry.name).png"))
}

// iconutil 出 .icns
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", output]
try process.run()
process.waitUntilExit()
guard process.terminationStatus == 0 else {
	FileHandle.standardError.write(Data("iconutil 失败\n".utf8))
	exit(1)
}
print("图标已生成：\(output)")
