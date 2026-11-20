import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FrameDecoder, encodeFrame } from "../../server/computer/framing.ts";
import { HelperClient, HelperError, CLIENT_API_VERSION } from "../../server/computer/helper-client.ts";
import { parseCommandPath } from "../../server/computer/cli.ts";

/** 假 helper：按 JSON-RPC 回复，记录收到的请求，便于断言参数 */
function startFakeHelper(
	socketFile: string,
	handle: (
		method: string,
		params: any,
	) => { result?: unknown; error?: { code: number; message: string; data?: unknown } },
) {
	const seen: Array<{ method: string; params: any }> = [];
	const server: Server = createServer((socket: Socket) => {
		const decoder = new FrameDecoder();
		socket.on("data", (chunk) => {
			for (const frame of decoder.push(chunk) as any[]) {
				seen.push({ method: frame.method, params: frame.params });
				const reply = handle(frame.method, frame.params) ?? {};
				socket.write(encodeFrame({ jsonrpc: "2.0", id: frame.id, ...reply }));
			}
		});
		socket.on("error", () => {});
	});
	return new Promise<{ server: Server; seen: typeof seen }>((resolve) => {
		server.listen(socketFile, () => resolve({ server, seen }));
	});
}

const HELLO_OK = {
	result: {
		serverApiVersion: CLIENT_API_VERSION,
		helperVersion: "test-1",
		pid: 42,
		permissions: { accessibility: true, screenRecording: false },
	},
};

describe("帧格式", () => {
	it("拆包：一帧被切成任意小块也能还原；多帧粘在一起也能拆开", () => {
		const a = encodeFrame({ jsonrpc: "2.0", id: 1, method: "hello" });
		const b = encodeFrame({ text: "你好，世界" });
		const bytes = Buffer.concat([a, b]);
		const decoder = new FrameDecoder();
		const out: unknown[] = [];
		for (let i = 0; i < bytes.length; i += 3) out.push(...decoder.push(bytes.subarray(i, i + 3)));
		assert.deepEqual(out, [{ jsonrpc: "2.0", id: 1, method: "hello" }, { text: "你好，世界" }]);
	});

	it("长度为 0 的帧是协议错误", () => {
		const decoder = new FrameDecoder();
		assert.throws(() => decoder.push(Buffer.from([0, 0, 0, 0])), /bad frame length 0/);
	});
});

describe("helper 客户端（对假 socket 服务）", () => {
	const dir = mkdtempSync(join(tmpdir(), "omaw-computer-"));
	const socketFile = join(dir, "agent-computer.sock");
	let server: Server;
	let seen: Array<{ method: string; params: any }>;
	let mode: "ok" | "mismatch" = "ok";

	before(async () => {
		const started = await startFakeHelper(socketFile, (method, params) => {
			if (method === "hello") {
				return mode === "mismatch" ? { result: { ...HELLO_OK.result, serverApiVersion: "turbo-0" } } : HELLO_OK;
			}
			if (method === "request" && params.requestType === "act" && params.payload.app === "Missing") {
				return { error: { code: 4013, message: "应用不存在", data: { name: "appMissing", retryable: false } } };
			}
			if (method === "request") return { result: { echo: params.requestType, payload: params.payload } };
			return { error: { code: -32601, message: "no such method" } };
		});
		server = started.server;
		seen = started.seen;
	});

	after(() => {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const newClient = () =>
		new HelperClient({
			socketPath: socketFile,
			clientName: "test",
			session: { sessionId: "s-1", turnId: null, agent: { name: "test-agent" } },
		});

	it("hello 握手返回版本与权限，请求带上 session 与截止时间", async () => {
		const client = newClient();
		const hello = await client.connect();
		assert.equal(hello.helperVersion, "test-1");
		assert.deepEqual(hello.permissions, { accessibility: true, screenRecording: false });
		const reply = (await client.request("findApps", {})) as any;
		assert.equal(reply.echo, "findApps");
		const req = seen.filter((s) => s.method === "request").at(-1)!;
		assert.equal(req.params.session.sessionId, "s-1");
		assert.equal(req.params.session.agent.name, "test-agent");
		assert.ok(req.params.deadlineUnixMillis > Date.now());
		client.close();
	});

	it("helper 返回的错误名与可重试标记被保留", async () => {
		const client = newClient();
		await client.connect();
		await assert.rejects(client.request("act", { app: "Missing", step: { type: "clickAt" } }), (error: unknown) => {
			assert.ok(error instanceof HelperError);
			assert.equal(error.errorName, "appMissing");
			assert.equal(error.retryable, false);
			return true;
		});
		client.close();
	});

	it("API 版本不一致时拒绝连接", async () => {
		mode = "mismatch";
		try {
			await assert.rejects(newClient().connect(), (error: unknown) => {
				assert.ok(error instanceof HelperError);
				assert.equal(error.errorName, "protocolMismatch");
				return true;
			});
		} finally {
			mode = "ok";
		}
	});

	it("连不上（没有 helper）时给出可读的错误", async () => {
		const client = new HelperClient({
			socketPath: join(dir, "nope.sock"),
			clientName: "test",
			session: { sessionId: "s", turnId: null },
		});
		await assert.rejects(client.connect(500), (error: unknown) => {
			assert.ok(error instanceof HelperError);
			assert.match(error.message, /连接 helper/);
			return true;
		});
	});
});

describe("菜单路径解析", () => {
	it("支持 ▸、> 与 → 三种分隔符，至少两级", () => {
		assert.deepEqual(parseCommandPath("文件 ▸ 存储"), ["文件", "存储"]);
		assert.deepEqual(parseCommandPath("File > Save As"), ["File", "Save As"]);
		assert.deepEqual(parseCommandPath("Edit → Copy"), ["Edit", "Copy"]);
		assert.throws(() => parseCommandPath("Save"), /不是菜单路径/);
	});
});

describe("设置与 Skill（使用临时 HOME，不碰真实用户目录）", () => {
	const home = mkdtempSync(join(tmpdir(), "omaw-home-"));
	const previousHome = process.env.HOME;
	before(() => {
		process.env.HOME = home;
	});
	after(() => {
		process.env.HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});

	it("写入只改提交的键，别的键原样保留；允许名单可往返", async () => {
		const { readSettings, writeSettings } = await import("../../server/computer/settings.ts");
		const dataDir = join(home, "Library", "Application Support", "AgentComputer");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			join(dataDir, "settings.json"),
			JSON.stringify({ custom: { keep: true }, focus: { forceFrontApps: ["x"] } }),
		);

		const after1 = writeSettings(
			{ previewEnabled: false, typingKeyDelayMs: 30, unprotectedApps: ["com.example.app", "com.example.two"] },
			home,
		);
		assert.equal(after1.previewEnabled, false);
		assert.equal(after1.typingKeyDelayMs, 30);
		assert.deepEqual(after1.unprotectedApps, ["com.example.app", "com.example.two"]);

		const raw = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
		assert.deepEqual(raw.custom, { keep: true });
		assert.deepEqual(raw.focus, { forceFrontApps: ["x"] }, "没碰的 focus 子键要保留");
		assert.equal(raw.preview.enabled, false);

		const reread = readSettings(home);
		assert.equal(reread.pointerSpeed, 1, "默认值");
		assert.deepEqual(reread.unprotectedApps, ["com.example.app", "com.example.two"]);
	});

	it("非法值直接报错，不写入", async () => {
		const { writeSettings } = await import("../../server/computer/settings.ts");
		assert.throws(() => writeSettings({ pointerSpeed: 99 }, home), /pointerSpeed/);
		assert.throws(() => writeSettings({ typingKeyDelayMs: 1.5 }, home), /整数/);
		assert.throws(() => writeSettings({ unprotectedApps: ["bad id with spaces"] }, home), /bundle id/);
	});

	it("settings.json 损坏时写入拒绝覆盖", async () => {
		const { writeSettings } = await import("../../server/computer/settings.ts");
		const file = join(home, "Library", "Application Support", "AgentComputer", "settings.json");
		writeFileSync(file, "{ not json");
		assert.throws(() => writeSettings({ previewEnabled: true }, home));
		assert.equal(readFileSync(file, "utf8"), "{ not json", "原文件不能被改");
	});

	it("Skill 启用写入 SKILL.md（含绝对 CLI 路径），禁用改名，不覆盖别人写的同名技能", async () => {
		const skill = await import("../../server/computer/skill.ts");
		const dir = skill.skillDir();
		assert.ok(dir.startsWith(home), "应指向临时 HOME 下的技能目录");

		skill.enableSkill("node /abs/cli.js");
		assert.equal(skill.skillEnabled(), true);
		const text = readFileSync(join(dir, "SKILL.md"), "utf8");
		assert.match(text, /^---\nname: agent-computer\n/);
		assert.ok(text.includes("node /abs/cli.js status"));
		assert.ok(!text.includes("{{CLI}}"));

		skill.disableSkill();
		assert.equal(skill.skillEnabled(), false);
		assert.ok(existsSync(join(dir, ".SKILL.md.disabled")));

		skill.enableSkill("node /abs/cli.js");
		assert.equal(skill.skillEnabled(), true);

		// 别人写的同名技能：不覆盖
		writeFileSync(join(dir, "SKILL.md"), "---\nname: agent-computer\n---\nmine\n");
		assert.throws(() => skill.enableSkill("node /abs/cli.js"), /不是本应用写入的/);
		skill.disableSkill(); // 也不改名
		assert.equal(skill.skillEnabled(), true);
	});
});
