/**
 * 非 pi 引擎的 MCP / 插件后端（`server/mcp/json-mcp-store.ts`、`server/plugins/engine-plugin-stores.ts`）。
 *
 * 要守住的四件事（都是这次踩过的真问题）：
 *   1. 切到哪个引擎，读的就是**那个引擎自己的文件**（不再拿 pi 的 mcp.json 冒充）；
 *   2. 写回时**只碰我们那一层**（别的键原样保留 —— `~/.claude.json` 里有几十个字段）；
 *   3. 能力位如实：claude 没有「启用/停用」、opencode 的插件只读，界面靠 `can` 隐藏按钮；
 *   4. 坏 JSON 不硬修（报错，不重写）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClaudeMcpStore, createOpencodeMcpStore } from "../../server/mcp/json-mcp-store.ts";
import { createNoneMcpStore } from "../../server/mcp/none-mcp-store.ts";
import { parseAddInput } from "../../server/mcp/mcp-engine-shared.ts";
import {
	createClaudePluginStore,
	createNonePluginStore,
	createOpencodePluginStore,
} from "../../server/plugins/engine-plugin-stores.ts";

const tempHome = (): string => mkdtempSync(join(tmpdir(), "omaw-engine-"));
const workspace = (): string => mkdtempSync(join(tmpdir(), "omaw-ws-"));

describe("claude 的 MCP 后端", () => {
	it("读 ~/.claude.json 的 mcpServers（stdio 与 http 都认），并说清改的是哪个文件", async () => {
		const home = tempHome();
		writeFileSync(
			join(home, "claude.json"),
			JSON.stringify({
				theme: "dark",
				mcpServers: {
					gh: { command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "${GH_TOKEN}" } },
					remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
				},
			}),
		);
		const store = createClaudeMcpStore({ home: join(home, "claude") });
		const view = await store.view(workspace());
		assert.equal(view.engine, "claude");
		assert.match(view.source ?? "", /claude\.json$/);
		assert.equal(view.total, 2);
		const gh = view.servers.find((server) => server.name === "gh");
		assert.equal(gh?.transport, "stdio");
		assert.equal(gh?.command, "npx");
		// ${GH_TOKEN} 要被识别成「宿主机变量」，界面才能提示没配
		assert.deepEqual(
			gh?.envRefs.map((ref) => ref.variable),
			["GH_TOKEN"],
		);
		assert.equal(view.servers.find((server) => server.name === "remote")?.transport, "http");
		// claude 的 mcpServers 没有 enabled 字段 → 面板不画启停
		assert.equal(view.can?.toggle, false);
	});

	it("添加只写 mcpServers，别的字段（theme…）原样保留", async () => {
		const home = tempHome();
		const file = join(home, "claude.json");
		writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: {} }));
		const store = createClaudeMcpStore({ home: join(home, "claude") });
		const result = await store.act({
			workspace: workspace(),
			action: "add",
			text: "npx -y @modelcontextprotocol/server-github",
		});
		assert.equal(result.actionError, undefined);
		const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		assert.equal(written.theme, "dark");
		const servers = written.mcpServers as Record<string, { command?: string }>;
		assert.equal(Object.keys(servers).length, 1);
		assert.equal(Object.values(servers)[0]?.command, "npx");
	});

	it("删除只删那一台；不存在的名字给可读错误", async () => {
		const home = tempHome();
		const file = join(home, "claude.json");
		writeFileSync(file, JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b" } } }));
		const store = createClaudeMcpStore({ home: join(home, "claude") });
		await store.act({ workspace: workspace(), action: "remove", name: "a" });
		const written = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
		assert.deepEqual(Object.keys(written.mcpServers), ["b"]);
		const missing = await store.act({ workspace: workspace(), action: "remove", name: "nope" });
		assert.match(missing.actionError ?? "", /找不到/);
	});

	it("坏 JSON 不改写：报错，配置原样留着", async () => {
		const home = tempHome();
		const file = join(home, "claude.json");
		writeFileSync(file, "{ 这不是 json");
		const store = createClaudeMcpStore({ home: join(home, "claude") });
		const view = await store.view(workspace());
		assert.match(view.errors?.[0] ?? "", /解析失败/);
		const result = await store.act({ workspace: workspace(), action: "add", text: "npx -y x" });
		assert.match(result.actionError ?? "", /解析失败/);
		assert.equal(readFileSync(file, "utf8"), "{ 这不是 json");
	});
});

describe("opencode 的 MCP 后端", () => {
	it("读 mcp 表（local / remote），启停能写回 enabled", async () => {
		const configHome = tempHome();
		mkdirSync(join(configHome, "opencode"), { recursive: true });
		const file = join(configHome, "opencode", "opencode.json");
		writeFileSync(
			file,
			JSON.stringify({
				model: "deepseek-office/deepseek-flash",
				mcp: {
					fs: { type: "local", command: ["npx", "-y", "fs-mcp"], enabled: true },
					api: { type: "remote", url: "https://api.example/mcp", enabled: false },
				},
			}),
		);
		const previous = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = configHome;
		try {
			const store = createOpencodeMcpStore();
			const view = await store.view(workspace());
			assert.equal(view.total, 2);
			assert.equal(view.servers.find((server) => server.name === "api")?.enabled, false);
			assert.equal(view.servers.find((server) => server.name === "fs")?.transport, "stdio");
			await store.act({ workspace: workspace(), action: "set-enabled", name: "api", enabled: true });
			const written = JSON.parse(readFileSync(file, "utf8")) as {
				model: string;
				mcp: Record<string, { enabled?: boolean }>;
			};
			// 只改 mcp.api.enabled，模型配置别碰
			assert.equal(written.model, "deepseek-office/deepseek-flash");
			assert.equal(written.mcp.api?.enabled, true);
			assert.equal(written.mcp.fs?.enabled, true);
		} finally {
			if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previous;
		}
	});

	it("项目级写在 <workspace>/opencode.json（作用域说了算）", async () => {
		const configHome = tempHome();
		process.env.XDG_CONFIG_HOME = configHome;
		const ws = workspace();
		const previous = process.env.XDG_CONFIG_HOME;
		try {
			const store = createOpencodeMcpStore();
			await store.act({ workspace: ws, action: "add", scope: "project", text: "https://mcp.example/sse" });
			const projectFile = join(ws, "opencode.json");
			const written = JSON.parse(readFileSync(projectFile, "utf8")) as {
				mcp: Record<string, { type?: string; url?: string }>;
			};
			assert.equal(Object.values(written.mcp)[0]?.type, "remote");
			assert.equal(Object.values(written.mcp)[0]?.url, "https://mcp.example/sse");
		} finally {
			if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previous;
		}
	});
});

describe("粘贴解析与空后端", () => {
	it("一段命令能解析成规范条目（三个引擎共用同一份解析）", () => {
		const parsed = parseAddInput({ text: "npx -y chrome-devtools-mcp@latest" });
		assert.ok(!("error" in parsed));
		if ("error" in parsed) return;
		assert.equal(parsed.config.command, "npx");
		assert.deepEqual(parsed.config.args?.slice(0, 1), ["-y"]);
	});

	it("dsh 这类没接的引擎：空列表 + 说明 + 所有动作都关掉", async () => {
		const store = createNoneMcpStore("dsh", "dsh 的 MCP 配置还没接", ["~/.dsh/mcp.json"]);
		const view = await store.view(workspace());
		assert.equal(view.engine, "dsh");
		assert.equal(view.total, 0);
		assert.equal(view.can?.add, false);
		assert.match(view.errors?.[0] ?? "", /还没接/);
		const acted = await store.act({ workspace: "x", action: "add", text: "npx -y x" });
		assert.match(acted.actionError ?? "", /还没接/);
	});
});

describe("非 pi 引擎的插件面板", () => {
	it("claude：读 settings.json 的 enabledPlugins，开关能写回且别的设置不动", async () => {
		const home = tempHome();
		const settings = join(home, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({
				language: "chinese",
				enabledPlugins: { "swift-lsp@claude-plugins-official": true, "cli-anything@cli-anything": false },
			}),
		);
		const store = createClaudePluginStore({ home });
		const view = await store.view(workspace());
		assert.equal(view.engine, "claude");
		assert.equal(view.packages.length, 2);
		assert.equal(view.packages.find((item) => item.source === "cli-anything@cli-anything")?.disabled, true);
		assert.equal(view.can?.toggle, true);
		// 安装/卸载不在这块面板里
		assert.equal(view.can?.install, false);

		await store.act({ workspace: workspace(), action: "enable", source: "cli-anything@cli-anything" });
		const written = JSON.parse(readFileSync(settings, "utf8")) as {
			language: string;
			enabledPlugins: Record<string, boolean>;
		};
		assert.equal(written.language, "chinese");
		assert.equal(written.enabledPlugins["cli-anything@cli-anything"], true);
	});

	it("opencode：插件数组只读（can 全 false，操作给一句说明）", async () => {
		const configHome = tempHome();
		mkdirSync(join(configHome, "opencode"), { recursive: true });
		writeFileSync(
			join(configHome, "opencode", "opencode.json"),
			JSON.stringify({ plugin: ["@acme/opencode-plugin", "./local-plugin.ts"] }),
		);
		const previous = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = configHome;
		try {
			const store = createOpencodePluginStore();
			const view = await store.view(workspace());
			assert.equal(view.packages.length, 2);
			assert.equal(view.can?.install, false);
			assert.equal(view.can?.toggle, false);
			const acted = await store.act({ workspace: workspace(), action: "install", source: "x" });
			assert.match(acted.actionError ?? "", /opencode\.json/);
		} finally {
			if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previous;
		}
	});

	it("dsh：没有插件概念 → 空视图 + 说明", async () => {
		const store = createNonePluginStore("dsh", "dsh 没有插件概念");
		const view = await store.view(workspace());
		assert.equal(view.packages.length, 0);
		assert.equal(view.can?.toggle, false);
		assert.equal(view.note, "dsh 没有插件概念");
	});
});
