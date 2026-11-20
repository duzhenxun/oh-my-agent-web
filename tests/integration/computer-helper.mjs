#!/usr/bin/env node
/**
 * helper 协议集成测试：真的起一个 helper 进程，走 socket 说 JSON-RPC。
 *
 *   node tests/integration/computer-helper.mjs            # 只测不需要授权的部分
 *   node tests/integration/computer-helper.mjs --ax       # 连 observe/点击/输入一起测（需要辅助功能授权）
 *
 * 为什么单独起进程：直接跑可执行文件会继承当前终端的「辅助功能」授权，
 * 所以即使在 TCC 还没给 .app 授权的情况下，也能验证 AX 逻辑本身是对的。
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const binary = join(root, "helper/computer-use-turbo-min/.build/out/Products/Release/TurboMinHelper");
const withAX = process.argv.includes("--ax");

const frame = (value) => {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length, 0);
	return Buffer.concat([header, body]);
};

/** 最小 JSON-RPC 客户端：攒字节、按帧切、按 id 配对 */
function connect(socketPath) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		let buffer = Buffer.alloc(0);
		let nextId = 1;
		const pending = new Map();
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 4) {
				const length = buffer.readUInt32LE(0);
				if (buffer.length < 4 + length) break;
				const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
				buffer = buffer.subarray(4 + length);
				const waiter = pending.get(message.id);
				if (!waiter) continue;
				pending.delete(message.id);
				if (message.error) {
					const error = new Error(message.error.message);
					error.name = message.error.data?.name ?? "unknown";
					error.retryable = message.error.data?.retryable;
					waiter.reject(error);
				} else {
					waiter.resolve(message.result);
				}
			}
		});
		socket.once("error", reject);
		socket.once("connect", () =>
			resolve({
				call(method, params) {
					const id = nextId++;
					return new Promise((res, rej) => {
						pending.set(id, { resolve: res, reject: rej });
						socket.write(frame({ jsonrpc: "2.0", id, method, params }));
					});
				},
				close: () => socket.end(),
			}),
		);
	});
}

const dir = mkdtempSync(join(tmpdir(), "turbo-helper-it-"));
const socketPath = join(dir, "turbo.sock");
let helper;

function startHelper() {
	helper = spawn(binary, [], { env: { ...process.env, CUT_SOCKET_PATH: socketPath }, stdio: "ignore" });
	// 等 socket 出现
	for (let i = 0; i < 100; i += 1) {
		if (existsSync(socketPath)) return;
		execFileSync("sleep", ["0.05"]);
	}
	throw new Error("helper 没起来");
}

function shutdown() {
	try { helper?.kill(); } catch {}
	try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

const request = (client, requestType, payload) =>
	client.call("request", {
		requestType,
		payload,
		deadlineUnixMillis: Date.now() + 30_000,
		session: { sessionId: "integration", turnId: null, agent: { name: "integration" } },
	});

async function main() {
	assert.ok(existsSync(binary), `先编译 helper：${binary}`);
	startHelper();
	const client = await connect(socketPath);

	// 1. 握手：版本必须是 turbo-1，否则客户端会直接拒绝
	const hello = await client.call("hello", { clientApiVersion: "turbo-1", clientName: "integration" });
	assert.equal(hello.serverApiVersion, "turbo-1");
	assert.ok(hello.helperVersion);
	assert.equal(typeof hello.pid, "number");
	console.log("✓ hello", hello.helperVersion, hello.permissions);

	// 版本不匹配必须被拒绝（防止半升级状态互相误伤）
	await assert.rejects(
		client.call("hello", { clientApiVersion: "turbo-0", clientName: "integration" }),
		/WEB_API|只支持/,
	);
	console.log("✓ 版本不匹配被拒绝");

	// 2. findApps 不需要权限
	const apps = await request(client, "findApps", {});
	assert.ok(Array.isArray(apps.apps) && apps.apps.length > 0);
	console.log("✓ findApps", apps.apps.length, "个应用");

	// 3. 权限查询
	const access = await request(client, "accessStatus", {});
	console.log("✓ accessStatus", access);

	// 4. 未 observe 就按编号操作 → 必须报清楚，而不是点到别处
	const noSnapshot = await request(client, "act", {
		app: apps.apps[0].name,
		step: { type: "clickAt", elementNumber: 1 },
	}).then(() => null, (error) => error);
	if (!access.accessibility) {
		assert.equal(noSnapshot?.name, "accessMissing");
		console.log("✓ 无权限时拒绝操作：", noSnapshot.message.slice(0, 40));
	} else {
		assert.equal(noSnapshot?.name, "badArguments");
		console.log("✓ 无快照时拒绝按编号点击");
	}

	if (withAX) {
		assert.ok(access.accessibility, "带了 --ax 但没有辅助功能权限；先给终端或 helper 授权");
		await axChecks(client);
	}

	client.close();
	shutdown();
	console.log("\n全部通过");
}

/** 从界面树文本里取某个元素的编号和屏幕坐标 */
function findElement(text, pattern) {
	for (const line of text.split("\n")) {
		if (!pattern.test(line)) continue;
		const number = Number(line.match(/#(\d+)/)[1]);
		const box = line.match(/\((-?\d+),(-?\d+),(\d+),(\d+)\)\s*$/);
		if (!box) return { number };
		return { number, x: Number(box[1]), y: Number(box[2]), w: Number(box[3]), h: Number(box[4]) };
	}
	return null;
}

/** 窗口原点（截图像素 → 屏幕坐标的换算基准） */
function windowOrigin(text) {
	const match = text.split("\n")[0].match(/@ (-?\d+),(-?\d+)/);
	return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 };
}

/** 真实操作：开一个 TextEdit 文档，写入、覆盖、两种点击、滚动、菜单、等待 */
async function axChecks(client) {
	// 用 open 打开一个真实文件：make new document 在 TextEdit 无窗口状态下可能不出现窗口
	// 用 .rtf：纯文本模式没有格式工具栏，粗体之类就用不了
	const file = join(dir, "helper-test.rtf");
	writeFileSync(file, "{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Helvetica;}}\\f0\\fs24 helper test}\n");
	execFileSync("osascript", ["-e", 'tell application "TextEdit" to close every document saving no'], { stdio: "ignore" });
	execFileSync("open", ["-a", "TextEdit", file]);
	await new Promise((r) => setTimeout(r, 2000));

	const opened = await request(client, "observeApp", { app: "TextEdit", includeScreenshot: true });
	assert.equal(opened.app.bundleId, "com.apple.TextEdit");
	assert.ok(opened.screenshot?.path, "应该有截图");
	assert.ok(opened.elementCount > 5);
	console.log("✓ observeApp", `${opened.elementCount} 个元素`, `截图 ${opened.screenshot.width}×${opened.screenshot.height}`, `scale=${opened.screenshot.scale}`);

	const textArea = findElement(opened.text, /AXTextArea/);
	assert.ok(textArea, "应该能找到文本区");
	console.log("✓ 文本区编号", textArea.number);

	// 写入 → 读回
	const marker = `加固测试-${Date.now() % 100000}`;
	await request(client, "act", {
		app: "TextEdit",
		step: { type: "writeText", text: marker, elementNumber: textArea.number },
	});
	const afterType = await request(client, "observeApp", { app: "TextEdit" });
	assert.ok(afterType.text.includes(marker), "写入的文字应该能读回来");
	console.log("✓ writeText 生效（可读回）");

	// 全选 + 覆盖：证明快捷键真的发出去了
	await request(client, "act", { app: "TextEdit", step: { type: "sendKeys", key: "cmd+a" } });
	const second = "hello";
	await request(client, "act", {
		app: "TextEdit",
		step: { type: "writeText", text: second, elementNumber: textArea.number },
	});
	const afterOverwrite = await request(client, "observeApp", { app: "TextEdit" });
	assert.ok(afterOverwrite.text.includes(second));
	assert.ok(!afterOverwrite.text.includes(marker), "旧文字应该被全选覆盖");
	console.log("✓ sendKeys cmd+a + 覆盖生效");

	// ① 按编号点击「粗体」复选框 → value 应该从 0 变 1
	const beforeBold = await request(client, "observeApp", { app: "TextEdit" });
	const bold = findElement(beforeBold.text, /desc="粗体"/);
	assert.ok(bold, "界面上应该有粗体复选框");
	await request(client, "act", { app: "TextEdit", step: { type: "clickAt", elementNumber: bold.number } });
	const afterBold = await request(client, "observeApp", { app: "TextEdit" });
	const boldLine = afterBold.text.split("\n").find((line) => /desc="粗体"/.test(line));
	assert.ok(/value="1"/.test(boldLine), `按编号点击后粗体应该打开，实际：${boldLine}`);
	console.log("✓ 按编号点击（AXPress）改变了界面状态");

	// ② 用截图坐标点回同一点 → 应该恢复 0（同时验证 Retina 换算）
	const origin = windowOrigin(afterBold.text);
	const scale = afterBold.screenshot?.scale ?? 1;
	const px = Math.round((bold.x + bold.w / 2 - origin.x) / scale);
	const py = Math.round((bold.y + bold.h / 2 - origin.y) / scale);
	await request(client, "act", { app: "TextEdit", step: { type: "clickAt", x: px, y: py } });
	const afterCoords = await request(client, "observeApp", { app: "TextEdit" });
	const coordsLine = afterCoords.text.split("\n").find((line) => /desc="粗体"/.test(line));
	assert.ok(/value="0"/.test(coordsLine), `坐标点击应该点回同一点，实际：${coordsLine}`);
	console.log("✓ 截图坐标点击命中同一点（Retina 换算正确）");

	// 滚动
	const scrolled = await request(client, "act", {
		app: "TextEdit",
		step: { type: "scrollView", elementNumber: textArea.number, direction: "down", pages: 1 },
	});
	assert.equal(scrolled.ok, true);
	console.log("✓ scrollView 执行成功");

	// 菜单枚举 + 按路径执行
	const commands = await request(client, "appCommands", { app: "TextEdit" });
	assert.ok(commands.commands.length > 10, "应该枚举到菜单命令");
	const target = commands.commands.find((item) => /bold|粗体/i.test(item.title));
	assert.ok(target, "菜单里应该有粗体");
	const ran = await request(client, "act", { app: "TextEdit", step: { type: "runCommand", path: target.path } });
	assert.equal(ran.ok, true);
	console.log("✓ appCommands", commands.count, "条 / runCommand", target.path.join(" ▸ "));

	// 等待界面稳定
	const waited = await request(client, "waitFor", { app: "TextEdit", until: "settled", timeoutMs: 3000 });
	assert.equal(waited.ok, true);
	console.log("✓ waitFor settled");

	// 收尾：不保存关掉测试文档
	execFileSync("osascript", ["-e", 'tell application "TextEdit" to close every document saving no'], { stdio: "ignore" });
}

main().catch((error) => {
	console.error("\n✗ 失败：", error.name, error.message);
	shutdown();
	process.exit(1);
});
