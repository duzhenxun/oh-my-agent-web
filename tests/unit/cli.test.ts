/**
 * 命令行参数（ADR-0031）：start / stop / restart + 选项 → 环境变量。
 * 只测纯函数；真正停进程要靠 server.lock 里记的 pid，不适合单测里演。
 */
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../server/cli.js";

describe("parseArgs", () => {
	it("默认是 start", () => {
		expect(parseArgs([])).toEqual({ command: "start", env: {}, help: false });
	});

	it("识别 stop / restart", () => {
		expect(parseArgs(["stop"]).command).toBe("stop");
		expect(parseArgs(["restart"]).command).toBe("restart");
	});

	it("选项转成环境变量（与 env.ts 同一套名字）", () => {
		const parsed = parseArgs(["start", "-p", "9000", "--host", "0.0.0.0", "-P", "pwd"]);
		expect(parsed.env).toMatchObject({ AGENT_WEB_PORT: "9000", AGENT_WEB_HOST: "0.0.0.0", AGENT_WEB_PASSWORD: "pwd" });
	});

	it("--help", () => {
		expect(parseArgs(["-h"]).help).toBe(true);
	});

	it("未知命令 / 缺参数值 → 抛错（而不是静默启动）", () => {
		expect(() => parseArgs(["boom"])).toThrow(/未知命令/);
		expect(() => parseArgs(["--port"])).toThrow(/缺少参数值/);
		expect(() => parseArgs(["--nope"])).toThrow(/未知选项/);
	});
});
