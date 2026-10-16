/**
 * 审批规则落盘（ADR-0006）：坏了不致命、写盘原子、规则可手工编辑。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createFileRuleStore,
	createMemoryRuleStore,
	hasRule,
	parseRules,
	rulesPath,
	withRule,
	type ApprovalRule,
} from "../../server/approval/rules.js";

let dataDir = "";

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "agent-web-rules-"));
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

const rule = (scopeKey: string): ApprovalRule => ({ scopeKey, scopeHint: scopeKey, createdAt: 1 });

describe("parseRules（纯函数，坏内容不致命）", () => {
	it("解析合法文件", () => {
		const text = JSON.stringify({ v: 1, rules: [{ scopeKey: "bash|npm", scopeHint: "命令 npm", createdAt: 5 }] });
		expect(parseRules(text)).toEqual([{ scopeKey: "bash|npm", scopeHint: "命令 npm", createdAt: 5 }]);
	});

	it("坏 JSON / 缺字段 / 非数组一律返回空规则（不抛错）", () => {
		expect(parseRules("{ 坏")).toEqual([]);
		expect(parseRules("{}")).toEqual([]);
		expect(parseRules('{"rules":{}}')).toEqual([]);
		expect(parseRules("null")).toEqual([]);
	});

	it("过滤掉形状不对的条目，保留能用的", () => {
		const text = JSON.stringify({ v: 1, rules: [{ scopeKey: "bash|npm" }, { nope: true }, "字符串"] });
		expect(parseRules(text)).toHaveLength(1);
	});

	it("缺 scopeHint/createdAt 时给出安全默认值", () => {
		expect(parseRules('{"rules":[{"scopeKey":"write|/a"}]}')).toEqual([
			{ scopeKey: "write|/a", scopeHint: "write|/a", createdAt: 0 },
		]);
	});
});

describe("规则集合（纯函数）", () => {
	it("hasRule 命中判断", () => {
		const rules = [rule("bash|npm")];
		expect(hasRule(rules, "bash|npm")).toBe(true);
		expect(hasRule(rules, "bash|rm")).toBe(false);
	});

	it("withRule 幂等（同一个「这类」不会重复写两条）", () => {
		const once = withRule([], rule("bash|npm"));
		const twice = withRule(once, rule("bash|npm"));
		expect(twice).toBe(once);
		expect(twice).toHaveLength(1);
	});

	it("withRule 不修改入参（纯函数）", () => {
		const original: ApprovalRule[] = [];
		withRule(original, rule("bash|npm"));
		expect(original).toHaveLength(0);
	});
});

describe("文件规则存储", () => {
	it("保存后能读回来，且是原子写（不留 .tmp）", async () => {
		const store = createFileRuleStore(dataDir);
		await store.save([rule("bash|npm")]);
		expect(existsSync(rulesPath(dataDir))).toBe(true);
		expect(existsSync(`${rulesPath(dataDir)}.tmp`)).toBe(false);
		expect(await store.load()).toEqual([rule("bash|npm")]);
	});

	it("文件不存在时返回空规则", async () => {
		expect(await createFileRuleStore(dataDir).load()).toEqual([]);
	});

	it("文件被写坏时返回空规则（不阻塞启动）", async () => {
		writeFileSync(rulesPath(dataDir), "{ 坏规则", "utf8");
		expect(await createFileRuleStore(dataDir).load()).toEqual([]);
	});

	it("落盘内容是人能手工编辑的 JSON（ADR-0006 说的「可手工编辑」）", async () => {
		await createFileRuleStore(dataDir).save([rule("write|/repo/docs")]);
		const parsed = JSON.parse(readFileSync(rulesPath(dataDir), "utf8"));
		expect(parsed.v).toBe(1);
		expect(parsed.rules[0].scopeKey).toBe("write|/repo/docs");
	});

	it("覆盖写不会留下旧内容", async () => {
		const store = createFileRuleStore(dataDir);
		await store.save([rule("a|1"), rule("b|2")]);
		await store.save([rule("c|3")]);
		expect(await store.load()).toEqual([rule("c|3")]);
	});
});

describe("内存规则存储", () => {
	it("可预置、可读写（单测用）", async () => {
		const store = createMemoryRuleStore([rule("bash|npm")]);
		expect(await store.load()).toHaveLength(1);
		await store.save([rule("bash|rm")]);
		expect(await store.load()).toEqual([rule("bash|rm")]);
	});
});
