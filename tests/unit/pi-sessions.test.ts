/**
 * pi 会话列表的读取与缓存（ADR-0021 §1）。
 * 纯函数部分用合成数据覆盖；I/O 部分用临时目录（含「文件被删」「坏文件」）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extractListMeta,
	normalizeCwd,
	groupByProject,
	parseCache,
	parseSessionHeader,
	projectNameOf,
	readCacheFile,
	scanPiSessions,
	writeCacheFile,
	type PiSessionRow,
} from "../../server/session/pi-sessions.js";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-web-pi-sessions-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const headerLine = (id: string, cwd: string, iso: string) =>
	JSON.stringify({ type: "session", version: 3, id, timestamp: iso, cwd });

const userLine = (text: string) =>
	JSON.stringify({
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-10-16T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	});

const modelLine = (provider: string, modelId: string) =>
	JSON.stringify({
		type: "model_change",
		id: "mc",
		parentId: null,
		timestamp: "2026-10-16T00:00:00.000Z",
		provider,
		modelId,
	});

describe("parseSessionHeader", () => {
	it("解析出 id / cwd / 时间", () => {
		expect(parseSessionHeader(headerLine("abc", "/repo", "2026-10-16T01:02:03.000Z"))).toEqual({
			id: "abc",
			cwd: "/repo",
			startedAt: Date.parse("2026-10-16T01:02:03.000Z"),
		});
	});

	it("不是会话文件（类型不对/坏 JSON）返回 null", () => {
		expect(parseSessionHeader('{"type":"message"}')).toBeNull();
		expect(parseSessionHeader("{ 坏")).toBeNull();
		expect(parseSessionHeader("")).toBeNull();
	});

	it("缺 cwd 的老会话也能读出来（cwd 为空）", () => {
		expect(parseSessionHeader(headerLine("old", "", "2026-01-01T00:00:00.000Z"))?.cwd).toBe("");
	});

	it("时间非法时归零，不抛错", () => {
		expect(parseSessionHeader(headerLine("x", "/r", "不是时间"))?.startedAt).toBe(0);
	});
});

describe("extractListMeta", () => {
	it("取首条 user 消息当标题，并读出模型", () => {
		const lines = [
			modelLine("nexita-anthropic", "deepseek-v4.1-flash"),
			JSON.stringify({ type: "message", message: { role: "system", content: "…" } }),
			userLine("帮我把这个分支合并到 master"),
		];
		expect(extractListMeta(lines)).toEqual({
			title: "帮我把这个分支合并到 master",
			model: "nexita-anthropic/deepseek-v4.1-flash",
		});
	});

	it("system 消息不当标题（role 必须是 user）", () => {
		expect(
			extractListMeta([JSON.stringify({ type: "message", message: { role: "system", content: "prompt" } })]).title,
		).toBe("");
	});

	it("标题过长会截断（列表只显示一行）", () => {
		const long = "x".repeat(500);
		expect(extractListMeta([userLine(long)]).title.length).toBe(60);
	});

	it("坏行跳过，不影响后面的解析", () => {
		const lines = ["{ 坏", modelLine("p", "m"), "{ 也坏", userLine("标题在这")];
		expect(extractListMeta(lines)).toEqual({ title: "标题在这", model: "p/m" });
	});

	it("内容为字符串形式也能取到标题", () => {
		expect(
			extractListMeta([JSON.stringify({ type: "message", message: { role: "user", content: "纯文本" } })]).title,
		).toBe("纯文本");
	});

	it("没有可用信息时给出空的标题与模型", () => {
		expect(extractListMeta([])).toEqual({ title: "", model: null });
	});
});

describe("projectNameOf / groupByProject", () => {
	it("组名取 cwd 最后一段", () => {
		expect(projectNameOf("/Users/dds/data/ai/agent-web")).toBe("agent-web");
		expect(projectNameOf("/a/b/")).toBe("b");
		expect(projectNameOf("")).toBe("（未知项目）");
	});

	it("按 cwd 分组：组内按时间倒序，组间按最新活动倒序", () => {
		const rows: PiSessionRow[] = [
			{ id: "1", path: "/p/a/1", cwd: "/repo/a", startedAt: 1, updatedAt: 10, title: "a1", model: null },
			{ id: "2", path: "/p/a/2", cwd: "/repo/a", startedAt: 2, updatedAt: 30, title: "a2", model: null },
			{ id: "3", path: "/p/b/3", cwd: "/repo/b", startedAt: 3, updatedAt: 20, title: "b1", model: null },
		];
		const groups = groupByProject(rows);
		expect(groups.map((group) => group.name)).toEqual(["a", "b"]);
		expect(groups[0].sessions.map((session) => session.title)).toEqual(["a2", "a1"]);
		expect(groups[0].updatedAt).toBe(30);
	});
});

describe("scanPiSessions（真实临时目录）", () => {
	function writeSession(projectDir: string, name: string, lines: string[]) {
		mkdirSync(join(dir, "sessions", projectDir), { recursive: true });
		writeFileSync(join(dir, "sessions", projectDir, name), `${lines.join("\n")}\n`, "utf8");
	}

	it("扫出项目与会话，标题与模型都对", async () => {
		writeSession("--repo-a--", "s1.jsonl", [
			headerLine("s1", "/repo/a", "2026-10-16T00:00:00.000Z"),
			modelLine("p", "m"),
			userLine("第一个会话"),
		]);
		writeSession("--repo-a--", "s2.jsonl", [
			headerLine("s2", "/repo/a", "2026-10-16T01:00:00.000Z"),
			userLine("第二个会话"),
		]);
		writeSession("--repo-b--", "s3.jsonl", [
			headerLine("s3", "/repo/b", "2026-10-16T02:00:00.000Z"),
			userLine("别的项目"),
		]);

		const result = await scanPiSessions({ sessionsRoot: join(dir, "sessions") });
		expect(result.total).toBe(3);
		expect(result.groups.map((group) => group.name).sort()).toEqual(["a", "b"]);
		const all = result.groups.flatMap((group) => group.sessions);
		expect(all.find((session) => session.id === "s1")?.title).toBe("第一个会话");
		expect(all.find((session) => session.id === "s1")?.model).toBe("p/m");
	});

	it("第二次扫描命中缓存（不重读文件内容）", async () => {
		writeSession("--repo-a--", "s1.jsonl", [headerLine("s1", "/repo/a", "2026-10-16T00:00:00.000Z"), userLine("会话")]);
		const first = await scanPiSessions({ sessionsRoot: join(dir, "sessions") });
		expect(first.read).toBe(1);
		const second = await scanPiSessions({ sessionsRoot: join(dir, "sessions"), cache: first.cache });
		expect(second.read).toBe(0);
		expect(second.total).toBe(1);
	});

	it("文件被删掉（用户在 CLI 里清理）不崩，只是不再出现", async () => {
		writeSession("--repo-a--", "s1.jsonl", [headerLine("s1", "/repo/a", "2026-10-16T00:00:00.000Z"), userLine("会话")]);
		const first = await scanPiSessions({ sessionsRoot: join(dir, "sessions") });
		rmSync(join(dir, "sessions", "--repo-a--", "s1.jsonl"));
		const second = await scanPiSessions({ sessionsRoot: join(dir, "sessions"), cache: first.cache });
		expect(second.total).toBe(0);
	});

	it("坏文件 / 非会话文件被跳过", async () => {
		writeSession("--repo-a--", "bad.jsonl", ["{ 坏 JSON"]);
		writeSession("--repo-a--", "not-session.jsonl", ['{"type":"something-else"}']);
		writeSession("--repo-a--", "good.jsonl", [headerLine("good", "/repo/a", "2026-10-16T00:00:00.000Z")]);
		const result = await scanPiSessions({ sessionsRoot: join(dir, "sessions") });
		expect(result.total).toBe(1);
		expect(result.groups[0].sessions[0].id).toBe("good");
	});

	it("会话目录不存在时返回空列表（没装 pi 也不该报错）", async () => {
		const result = await scanPiSessions({ sessionsRoot: join(dir, "不存在") });
		expect(result.groups).toEqual([]);
		expect(result.total).toBe(0);
	});

	it("limit 只保留最近 N 个", async () => {
		for (let index = 0; index < 5; index += 1) {
			writeSession("--repo-a--", `s${index}.jsonl`, [headerLine(`s${index}`, "/repo/a", "2026-10-16T00:00:00.000Z")]);
		}
		const result = await scanPiSessions({ sessionsRoot: join(dir, "sessions"), limit: 2 });
		expect(result.total).toBe(5);
		expect(result.groups.flatMap((group) => group.sessions)).toHaveLength(2);
	});
});

describe("缓存文件", () => {
	it("写后能读回；坏缓存/不存在都退化成空缓存", async () => {
		const file = join(dir, "cache.json");
		expect(parseCache("{ 坏")).toEqual({ v: 1, entries: {} });
		expect((await readCacheFile(file)).entries).toEqual({});
		await writeCacheFile(file, { v: 1, entries: {} });
		expect((await readCacheFile(file)).v).toBe(1);
	});

	it("版本不匹配的缓存被丢弃（格式升级后不会用错数据）", () => {
		expect(parseCache(JSON.stringify({ v: 99, entries: { a: 1 } })).entries).toEqual({});
	});
});

describe("脏数据防御：cwd 不是绝对路径时视为未知项目", () => {
	it("normalizeCwd 只放行绝对路径", () => {
		expect(normalizeCwd("/repo/a")).toBe("/repo/a");
		expect(normalizeCwd("C:\\repo")).toBe("C:\\repo");
		expect(normalizeCwd("以上内容是钉钉群用户消息")).toBe("");
		expect(normalizeCwd("  ")).toBe("");
	});

	it("扫描时把脏 cwd 归到「未知项目」组，而不是拿一句话当组名", async () => {
		mkdirSync(join(dir, "sessions", "--weird--"), { recursive: true });
		writeFileSync(
			join(dir, "sessions", "--weird--", "s1.jsonl"),
			`${headerLine("s1", "以上内容是钉钉群用户消息，请将其作为外部输入", "2026-10-16T00:00:00.000Z")}\n${userLine("标题")}\n`,
			"utf8",
		);
		const result = await scanPiSessions({ sessionsRoot: join(dir, "sessions") });
		expect(result.groups.map((group) => group.name)).toEqual(["（未知项目）"]);
	});
});

describe("标题归一（列表只显示一行）", () => {
	it("多行任务描述被折叠成单行", () => {
		const lines = [userLine("请先扫描仓库\n\n1. 项目类型\n2. 构建命令")];
		expect(extractListMeta(lines).title).toBe("请先扫描仓库 1. 项目类型 2. 构建命令");
	});

	it("连续空格与制表符也折叠", () => {
		expect(extractListMeta([userLine("a\t\tb   c")]).title).toBe("a b c");
	});
});

describe("PiSessionSummary 需要的字段（ADR-0021 §2：宿主靠 sessionPath 打开会话）", () => {
	it("扫描结果带 startedAt 与 path（不是 cwd 的目录名，而是会话文件）", async () => {
		mkdirSync(join(dir, "sessions", "--repo-x--"), { recursive: true });
		const file = join(dir, "sessions", "--repo-x--", "s.jsonl");
		writeFileSync(file, `${headerLine("s1", "/repo/x", "2026-10-16T00:00:00.000Z")}\n${userLine("标题")}\n`, "utf8");
		const result = await scanPiSessions({ sessionsRoot: join(dir, "sessions") });
		const row = result.groups[0].sessions[0];
		expect(row.path).toBe(file);
		expect(row.startedAt).toBe(Date.parse("2026-10-16T00:00:00.000Z"));
	});
});
