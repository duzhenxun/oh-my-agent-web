/**
 * 启动自检（ADR-0007）：数据目录可写 + 端口错误翻译成人话。
 */
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDataDirWritable, describeListenError } from "../../server/util/startup.js";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-web-startup-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("checkDataDirWritable", () => {
	it("目录不存在会创建，并留不下探针文件", async () => {
		const nested = join(dir, "a", "b");
		const result = await checkDataDirWritable(nested);
		expect(result.ok).toBe(true);
		expect(existsSync(nested)).toBe(true);
		expect(existsSync(join(nested, ".write-probe"))).toBe(false);
	});

	it("不可写的目录给出可读的原因", async () => {
		const readOnly = join(dir, "readonly");
		await checkDataDirWritable(readOnly);
		chmodSync(readOnly, 0o500);
		const result = await checkDataDirWritable(readOnly);
		// root 用户跑测试时权限位无效，跳过这种情况
		if (typeof process.getuid === "function" && process.getuid() === 0) return;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("数据目录不可写");
		chmodSync(readOnly, 0o700);
	});
});

describe("describeListenError", () => {
	it("端口占用给的是「谁可能占着、怎么查」而不是裸错误码", () => {
		const text = describeListenError({ code: "EADDRINUSE" }, 8790);
		expect(text).toContain("8790");
		expect(text).toContain("server.lock");
	});

	it("可以带上占用者的提示", () => {
		const text = describeListenError({ code: "EADDRINUSE" }, 8790, "pid 123 占着");
		expect(text).toContain("pid 123");
	});

	it("权限不足时点明原因", () => {
		expect(describeListenError({ code: "EACCES" }, 80)).toContain("权限");
	});

	it("未知错误也不吞掉错误码", () => {
		expect(describeListenError({ code: "EWHATEVER" }, 8790)).toContain("EWHATEVER");
	});
});
