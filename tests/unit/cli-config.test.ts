/**
 * CLI 选项的持久化兜底：重启时少带参数不该把远程访问关掉。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyStoredOptions, readStoredOptions } from "../../server/cli-config.js";

const dirs: string[] = [];
const makeDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "agent-web-cli-"));
	dirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI 选项兜底（password / allowed-hosts）", () => {
	it("两个文件都没有：什么都不补（等同只允许本机）", async () => {
		const env: Record<string, string | undefined> = {};
		expect(await applyStoredOptions(env, makeDir())).toEqual({ password: false, allowedHosts: false });
		expect(env).toEqual({});
	});

	it("文件存在：补进 env（只取第一行、去空白）", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "password"), "  s3cret  \n第二行忽略\n");
		writeFileSync(join(dir, "allowed-hosts"), "agent.xs25.cn, pi.xs25.cn\n");
		const env: Record<string, string | undefined> = {};
		expect(await applyStoredOptions(env, dir)).toEqual({ password: true, allowedHosts: true });
		expect(env.AGENT_WEB_PASSWORD).toBe("s3cret");
		expect(env.AGENT_WEB_ALLOWED_HOSTS).toBe("agent.xs25.cn,pi.xs25.cn");
	});

	it("命令行/环境变量优先：已有值就不覆盖", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "password"), "文件里的");
		const env: Record<string, string | undefined> = { AGENT_WEB_PASSWORD: "命令行给的" };
		expect(await applyStoredOptions(env, dir)).toEqual({ password: false, allowedHosts: false });
		expect(env.AGENT_WEB_PASSWORD).toBe("命令行给的");
	});

	it("空文件当没设（别把空密码当成「已设密码」）", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "password"), "\n \n");
		writeFileSync(join(dir, "allowed-hosts"), "\n");
		expect(await readStoredOptions(dir)).toEqual({ password: null, allowedHosts: [] });
	});
});
