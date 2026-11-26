/**
 * 引擎安装器（`server/engine/engine-install.ts`，ADR-0052）。
 *
 * 这层最贵的错法是「装错地方」：装进系统全局要 sudo、会污染用户环境；
 * 装进一个自造目录则 npm 说不清、用户 `npm ls -g` 也看不见。
 * 所以这里把落点（npm prefix = dataDir）、参数形状、PATH 追加顺序都钉死。
 *
 * 一律用注入的 `find` / `exists` / `piPath`，所以测试不装任何东西、不碰网络。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	engineStatus,
	ensurePrefixOnPath,
	npmInstallArgs,
	npmPrefix,
	prefixBinDir,
} from "../../server/engine/engine-install.js";

const DATA_DIR = "/Users/me/.oh-my-agent-web";

describe("安装落点", () => {
	it("npm prefix 就是数据目录（与 scripts/install.sh 一致，不碰系统全局）", () => {
		assert.equal(npmPrefix(DATA_DIR), DATA_DIR);
	});

	it("bin 目录跟着平台：POSIX 是 <prefix>/bin，Windows 直接是 <prefix>", () => {
		assert.equal(prefixBinDir("/home/me/.oh-my-agent-web", "darwin"), "/home/me/.oh-my-agent-web/bin");
		assert.equal(prefixBinDir("C:\\Users\\me\\.oh-my-agent-web", "win32"), "C:\\Users\\me\\.oh-my-agent-web");
	});

	it("npm 参数：--global 与 --prefix 一起用，包名带 @latest", () => {
		const args = npmInstallArgs(["@openai/codex@latest"], DATA_DIR);
		assert.deepEqual(args.slice(0, 2), ["install", "--global"]);
		assert.equal(args[args.indexOf("--prefix") + 1], DATA_DIR);
		assert.equal(args.at(-1), "@openai/codex@latest");
		// 静音与安全相关的开关要带上（桌面 App 里不该刷一堆 audit 输出）
		assert.ok(args.includes("--no-audit"));
		assert.ok(args.includes("--no-fund"));
	});
});

describe("engineStatus", () => {
	it("pi 只看模块能不能解析（它走 SDK，和 PATH 里的 pi 命令无关）", () => {
		const missing = engineStatus("pi", { dataDir: DATA_DIR, piPath: null });
		assert.equal(missing.installed, false);
		assert.equal(missing.path, null);
		assert.equal(missing.installable, true);

		const present = engineStatus("pi", {
			dataDir: DATA_DIR,
			piPath: "/x/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
		});
		assert.equal(present.installed, true);
		assert.match(present.path ?? "", /pi-coding-agent/);
	});

	it("显式 AGENT_WEB_*_BIN 优先（用户指哪就认哪，不去 PATH 里猜）", () => {
		const status = engineStatus("codex", {
			dataDir: DATA_DIR,
			env: { AGENT_WEB_CODEX_BIN: "/opt/mine/codex" },
			find: () => "/should/not/be/used",
		});
		assert.equal(status.installed, true);
		assert.equal(status.path, "/opt/mine/codex");
	});

	it("PATH 里能找到就是已装", () => {
		const status = engineStatus("opencode", {
			dataDir: DATA_DIR,
			env: {},
			find: (bin) => (bin === "opencode" ? "/usr/local/bin/opencode" : null),
		});
		assert.equal(status.installed, true);
		assert.equal(status.path, "/usr/local/bin/opencode");
	});

	it("哪儿都没有 → 未安装，但可以一键装", () => {
		const status = engineStatus("claude", { dataDir: DATA_DIR, env: {}, find: () => null, exists: () => false });
		assert.equal(status.installed, false);
		assert.equal(status.installable, true);
		assert.ok(status.guide.length > 0, "没装时也要给出自己装的写法");
	});

	it("dsh 不可一键装（没有公开 npm 包），但照样能读到它自己装没装", () => {
		const status = engineStatus("dsh", { dataDir: DATA_DIR, env: {}, find: () => null, exists: () => false });
		assert.equal(status.installable, false);
		assert.equal(status.installed, false);
	});
});

describe("ensurePrefixOnPath", () => {
	it("装过的 bin 目录要**追加**在 PATH 末尾（用户自己的同名命令仍然优先）", () => {
		const env = { PATH: "/usr/local/bin:/usr/bin" };
		const added = ensurePrefixOnPath(DATA_DIR, env, {
			platform: "darwin",
			exists: (path) => path === `${DATA_DIR}/bin`,
		});
		assert.equal(added, `${DATA_DIR}/bin`);
		assert.equal(env.PATH, `/usr/local/bin:/usr/bin:${DATA_DIR}/bin`);
	});

	it("没装过（目录不存在）就不动 PATH —— 不该多出一条空目录", () => {
		const env = { PATH: "/usr/bin" };
		const added = ensurePrefixOnPath(DATA_DIR, env, { platform: "darwin", exists: () => false });
		assert.equal(added, null);
		assert.equal(env.PATH, "/usr/bin");
	});

	it("幂等：重启时重复挂不会把同一个目录塞两遍", () => {
		const env = { PATH: `/usr/bin:${DATA_DIR}/bin` };
		ensurePrefixOnPath(DATA_DIR, env, { platform: "darwin", exists: () => true });
		assert.equal(env.PATH, `/usr/bin:${DATA_DIR}/bin`);
	});
});
