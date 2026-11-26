#!/usr/bin/env node
/**
 * 编译**电脑控制 helper**（macOS），并产出分发用的 zip。
 *
 * 为什么要单独一步：helper 是**构建产物**（`helper/agent-computer/release/` 在 `.gitignore` 里，
 * 干净 clone 里没有它）。zip 由 `build-app.sh` 用 ditto 打出来，前端「未安装电脑控制」时直接给这个下载链接 ——
 * 发版前不跑这一步，用户点「安装」会拿到 404，而且**不会报错**（这才是最坑的）。
 *
 * 只有 macOS：Windows 版电脑控制**还没做**（2026-11-24 用户决定先不做，界面上显示「敬请期待」），
 * 所以非 darwin 平台直接跳过，也不为此引入 dotnet 之类的新工具链。
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_DIR = join(ROOT, "helper", "agent-computer");
const RELEASE_DIR = join(HELPER_DIR, "release");

/**
 * 电脑控制 helper 目前**只有 macOS 实现**（Swift + AppKit + Accessibility + ScreenCaptureKit）。
 *
 * Windows 版还没做（2026-11-24 用户决定：先不做 Windows 的电脑控制，界面上显示「敬请期待」）。
 * 所以这里不再尝试编 Windows 二进制，也不该让 macOS 打包因为「找不到 dotnet」而报错 ——
 * 非 darwin 平台直接跳过（macOS 的产物本来就不该带 exe）。
 */
if (process.platform !== "darwin") {
	console.log(`[helper] 跳过：电脑控制 helper 目前只有 macOS 实现（当前 ${process.platform}）`);
	process.exit(0);
}

if (!existsSync(join(HELPER_DIR, "Package.swift"))) {
	console.error(`[helper] 找不到 helper 源码：${HELPER_DIR}`);
	process.exit(1);
}

console.log("[helper] 编译电脑控制 helper（swift build -c release）");
const result = spawnSync("sh", [join(HELPER_DIR, "scripts", "build-app.sh")], {
	cwd: ROOT,
	stdio: "inherit",
});
if (result.status !== 0) {
	console.error(`[helper] 编译失败（退出码 ${result.status ?? "null"}）—— 这个包里的「电脑控制」会是坏的，先修好再打包`);
	process.exit(1);
}

/** 分发产物：`release/Agent Computer.zip`（前端「未安装」时给的下载链接指向它） */
const zip = join(RELEASE_DIR, "Agent Computer.zip");
if (!existsSync(zip)) {
	console.error(`[helper] 编译结束但没找到分发 zip：${zip}`);
	process.exit(1);
}
console.log(`[helper] 分发 zip 就绪：${zip}`);
