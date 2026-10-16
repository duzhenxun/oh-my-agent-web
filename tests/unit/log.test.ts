/**
 * 日志（ADR-0013）：脱敏 + 级别过滤 + 单行 JSON + 文件轮转。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, formatLogLine, redactLogContext } from "../../server/util/log.js";
import { archivePlan, createRotatingFileSink, logFileName } from "../../server/util/log-file.js";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-web-log-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("脱敏（ADR-0013 §B）", () => {
	it("key / token / secret / password / cookie 一律抹掉", () => {
		const redacted = redactLogContext({
			apiKey: "sk-123",
			api_key: "sk-123",
			"api-key": "sk-123",
			token: "abc",
			accessToken: "abc",
			secret: "x",
			password: "p",
			authorization: "Bearer x",
			cookie: "pi_web=1",
			keep: "ok",
		});
		expect(redacted.apiKey).toBe("[redacted]");
		expect(redacted.api_key).toBe("[redacted]");
		expect(redacted["api-key"]).toBe("[redacted]");
		expect(redacted.token).toBe("[redacted]");
		expect(redacted.accessToken).toBe("[redacted]");
		expect(redacted.secret).toBe("[redacted]");
		expect(redacted.password).toBe("[redacted]");
		expect(redacted.authorization).toBe("[redacted]");
		expect(redacted.cookie).toBe("[redacted]");
		expect(redacted.keep).toBe("ok");
	});

	it("长文本被截断并标注原长度（不把文件正文写进日志）", () => {
		const redacted = redactLogContext({ body: "x".repeat(5000) });
		expect(String(redacted.body)).toContain("[5000 字]");
		expect(String(redacted.body).length).toBeLessThan(300);
	});

	it("嵌套对象里的敏感字段同样被抹掉", () => {
		const redacted = redactLogContext({ headers: { authorization: "Bearer x", accept: "*/*" } });
		expect(redacted.headers).toEqual({ authorization: "[redacted]", accept: "*/*" });
	});

	it("数组会被截断到 20 项", () => {
		const redacted = redactLogContext({ list: Array.from({ length: 50 }, (_, index) => index) });
		expect(Array.isArray(redacted.list) && redacted.list).toHaveLength(20);
	});
});

describe("logger", () => {
	it("输出单行 JSON，带 ts/level/scope/msg", () => {
		const lines: string[] = [];
		const logger = createLogger({ level: "info", scope: "app", now: () => 1234, sink: (line) => lines.push(line) });
		logger.info("hello", { port: 8790 });
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed).toMatchObject({ ts: 1234, level: "info", scope: "app", msg: "hello", ctx: { port: 8790 } });
	});

	it("低于门槛的级别不输出", () => {
		const lines: string[] = [];
		const logger = createLogger({ level: "warn", sink: (line) => lines.push(line) });
		logger.debug("d");
		logger.info("i");
		logger.warn("w");
		logger.error("e");
		expect(lines).toHaveLength(2);
	});

	it("子 logger 的 scope 是拼接的", () => {
		const lines: string[] = [];
		const logger = createLogger({ level: "info", scope: "app", sink: (line) => lines.push(line) });
		logger.child("engine").info("x");
		expect(JSON.parse(lines[0]).scope).toBe("app.engine");
	});

	it("日志上下文在写入前就被脱敏（不是靠调用方自觉）", () => {
		const lines: string[] = [];
		createLogger({ level: "info", sink: (line) => lines.push(line) }).info("x", { apiKey: "sk-live-123" });
		expect(lines[0]).not.toContain("sk-live-123");
		expect(lines[0]).toContain("[redacted]");
	});

	it("formatLogLine 无 ctx 时也给出合法 JSON", () => {
		expect(() => JSON.parse(formatLogLine({ ts: 1, level: "info", scope: "s", msg: "m" }))).not.toThrow();
	});
});

describe("文件轮转（ADR-0013 §B）", () => {
	it("archivePlan 决定保留几个归档", () => {
		expect(archivePlan(3)).toEqual([1, 2, 3]);
		expect(archivePlan(0)).toEqual([]);
	});

	it("写到上限就轮转，且保留数量正确", () => {
		const file = logFileName(dir);
		const sink = createRotatingFileSink({ file, maxBytes: 200, keep: 2 });
		// 每行约 60 字节 → 写 10 行必然触发多次轮转
		for (let index = 0; index < 10; index += 1) sink.write(`line-${index} ${"x".repeat(50)}`);

		expect(existsSync(file)).toBe(true);
		expect(existsSync(`${file}.1`)).toBe(true);
		expect(existsSync(`${file}.3`)).toBe(false); // keep=2 → 最多 .1/.2
		expect(sink.size()).toBeLessThanOrEqual(200);
	});

	it("轮转不会丢掉最新一行", () => {
		const file = logFileName(dir);
		const sink = createRotatingFileSink({ file, maxBytes: 100, keep: 3 });
		for (let index = 0; index < 6; index += 1) sink.write(`line-${index}`);
		sink.write("LAST-LINE");
		expect(readFileSync(file, "utf8")).toContain("LAST-LINE");
	});

	it("目录不存在会自动创建", () => {
		const file = join(dir, "nested", "logs", "a.log");
		createRotatingFileSink({ file, maxBytes: 1000, keep: 1 }).write("x");
		expect(existsSync(file)).toBe(true);
	});

	it("写不进去时只回调报错，不抛（日志不能把程序搞崩）", () => {
		const errors: string[] = [];
		// 父路径是一个**文件**而不是目录 → 建目录与写文件都会失败
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "not a directory", "utf8");
		const sink = createRotatingFileSink({ file: join(blocked, "a.log"), onError: (message) => errors.push(message) });
		expect(() => sink.write("x")).not.toThrow();
		expect(errors.length).toBeGreaterThan(0);
	});
});
