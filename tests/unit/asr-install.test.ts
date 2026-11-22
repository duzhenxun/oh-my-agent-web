/**
 * 本地识别程序的「装在哪 / 从哪下 / 用哪份 / 装完能不能用」（`server/asr/paths.ts` + `install.ts`）。
 *
 * 为什么值得单测：这条链路上有几个「静默错」很容易踩
 *   - 下载地址少了 `release/` 或 `raw/`，用户点安装只看到 404；
 *   - 装到包目录而不是 Application Support，npm 一升级 TCC 授权就重问（用户以为坏了）；
 *   - 「已经装好」的判断只看目录在不在，不看可执行文件 —— 半装状态会显示就绪然后起不来。
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const { asrDownloadUrl, asrSupportDir, installedAppPath, pickAsrAppPath, resolveAsrAppPath } =
	await import("../../server/asr/paths.ts");
const { installAsrApp } = await import("../../server/asr/install.ts");

const saved = {
	dir: process.env.OH_MY_AGENT_ASR_DIR,
	app: process.env.OH_MY_AGENT_ASR_APP,
	url: process.env.OH_MY_AGENT_ASR_DOWNLOAD_URL,
};

function restoreEnv(): void {
	for (const [key, value] of [
		["OH_MY_AGENT_ASR_DIR", saved.dir],
		["OH_MY_AGENT_ASR_APP", saved.app],
		["OH_MY_AGENT_ASR_DOWNLOAD_URL", saved.url],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

let work = "";

/** 造一个「装好了」的 .app：可执行文件在才算 */
async function fakeApp(root: string, withBinary = true): Promise<string> {
	const app = join(root, "ASRBridge.app");
	const bin = join(app, "Contents/MacOS");
	await mkdir(bin, { recursive: true });
	if (withBinary) {
		await writeFile(join(bin, "asr-bridge"), "#!/bin/sh\n");
		await chmod(join(bin, "asr-bridge"), 0o755);
	}
	return app;
}

before(async () => {
	work = await mkdtemp(join(tmpdir(), "oh-my-agent-web-asr-test-"));
	delete process.env.OH_MY_AGENT_ASR_APP;
	delete process.env.OH_MY_AGENT_ASR_DOWNLOAD_URL;
	process.env.OH_MY_AGENT_ASR_DIR = join(work, "support", "asr");
});

after(async () => {
	restoreEnv();
	await rm(work, { recursive: true, force: true });
});

describe("下载地址", () => {
	it("默认指向仓库里的预编译包", () => {
		assert.match(asrDownloadUrl({}), /^https:\/\/github\.com\/.+\/raw\/main\/helper\/asr\/release\/ASRBridge\.zip$/);
	});

	it("OH_MY_AGENT_ASR_DOWNLOAD_URL 可以整体换掉（自建源 / 内网镜像）", () => {
		assert.equal(
			asrDownloadUrl({ OH_MY_AGENT_ASR_DOWNLOAD_URL: " https://example.com/asr.zip " }),
			"https://example.com/asr.zip",
		);
	});
});

describe("装在哪", () => {
	it("默认落在 Application Support（不写包目录：npm 升级不会替换它）", () => {
		assert.equal(
			installedAppPath("/Users/someone", {}),
			"/Users/someone/Library/Application Support/oh-my-agent-web/asr/ASRBridge.app",
		);
	});

	it("OH_MY_AGENT_ASR_DIR 可以改安装目录", () => {
		assert.equal(asrSupportDir("/Users/someone", { OH_MY_AGENT_ASR_DIR: "/tmp/x" }), "/tmp/x");
	});
});

describe("用哪份 .app", () => {
	const installed = "/support/asr/ASRBridge.app";

	it("显式指定最高优先", () => {
		assert.equal(
			pickAsrAppPath({ override: "/custom/app", installed, installedExists: true, bundled: null }),
			"/custom/app",
		);
	});

	it("装过就用装的那份（而不是仓库里的产物）", () => {
		assert.equal(
			pickAsrAppPath({ installed, installedExists: true, bundled: "/repo/helper/asr/ASRBridge.app" }),
			installed,
		);
	});

	it("没装但有 build.sh 的产物 → 直接用（开发机不必再装一份）", () => {
		assert.equal(
			pickAsrAppPath({ installed, installedExists: false, bundled: "/repo/helper/asr/ASRBridge.app" }),
			"/repo/helper/asr/ASRBridge.app",
		);
	});

	it("都没有 → 回安装目标路径（报错里的路径 = 手动下载该放的地方）", () => {
		assert.equal(pickAsrAppPath({ installed, installedExists: false, bundled: null }), installed);
	});

	it("装好之后 resolveAsrAppPath 立刻能找到（不用重启服务）", async () => {
		const support = process.env.OH_MY_AGENT_ASR_DIR!;
		await rm(support, { recursive: true, force: true });
		const app = await fakeApp(support);
		assert.equal(resolveAsrAppPath(), app);
	});
});

describe("安装", () => {
	it("已经装好 → 直接成功，不重新下载", async () => {
		const support = process.env.OH_MY_AGENT_ASR_DIR!;
		await rm(support, { recursive: true, force: true });
		await fakeApp(support);
		const result = await installAsrApp();
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.via, "already");
			assert.equal(result.appPath, installedAppPath());
		}
	});

	it("连点两下只跑一次（两个调用拿到同一个结果）", async () => {
		const support = process.env.OH_MY_AGENT_ASR_DIR!;
		await rm(support, { recursive: true, force: true });
		await fakeApp(support);
		const first = installAsrApp();
		const second = installAsrApp();
		assert.equal(first, second);
		const [a, b] = await Promise.all([first, second]);
		assert.equal(a, b);
	});
});
