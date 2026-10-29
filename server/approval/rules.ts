/**
 * 审批规则落盘：`<dataDir>/approval-rules.json`（ADR-0006）。
 *
 * 规则形状刻意保持「人能手工编辑」的程度：
 *   { "v": 1, "rules": [{ "scopeKey": "bash|npm", "scopeHint": "命令 npm", "createdAt": 1699999999999 }] }
 *
 * 三条纪律：
 *   1. 文件坏了/被删了 → 当作没有规则（**不能**因此拒绝启动；规则只是便利，不是安全边界）；
 *   2. 写盘原子（temp + rename），避免半截 JSON；
 *   3. 规则只增不减（v1 没有管理 UI，要删就手工编辑文件）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const RULES_FILE = "approval-rules.json";
const RULES_VERSION = 1;

export type ApprovalRule = {
	scopeKey: string;
	scopeHint: string;
	createdAt: number;
};

type RulesFile = { v: number; rules: ApprovalRule[] };

function rulesPath(dataDir: string): string {
	return join(dataDir, RULES_FILE);
}

function isRule(value: unknown): value is ApprovalRule {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.scopeKey === "string" && candidate.scopeKey !== "";
}

/** 纯函数：解析规则文件；坏内容一律返回空规则（不抛错） */
function parseRules(text: string): ApprovalRule[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null) return [];
	const rules = (parsed as Record<string, unknown>).rules;
	if (!Array.isArray(rules)) return [];
	return rules.filter(isRule).map((rule) => ({
		scopeKey: rule.scopeKey,
		scopeHint: typeof rule.scopeHint === "string" ? rule.scopeHint : rule.scopeKey,
		createdAt: typeof rule.createdAt === "number" ? rule.createdAt : 0,
	}));
}

export function hasRule(rules: ApprovalRule[], scopeKey: string): boolean {
	return rules.some((rule) => rule.scopeKey === scopeKey);
}

/** 纯函数：加一条规则（已存在则原样返回，保持幂等） */
export function withRule(rules: ApprovalRule[], rule: ApprovalRule): ApprovalRule[] {
	if (hasRule(rules, rule.scopeKey)) return rules;
	return [...rules, rule];
}

export type RuleStore = {
	load(): Promise<ApprovalRule[]>;
	save(rules: ApprovalRule[]): Promise<void>;
};

export function createFileRuleStore(dataDir: string): RuleStore {
	return {
		async load() {
			try {
				return parseRules(await readFile(rulesPath(dataDir), "utf8"));
			} catch {
				return []; // 文件不存在/读不了 = 没有规则
			}
		},
		async save(rules) {
			const target = rulesPath(dataDir);
			await mkdir(dirname(target), { recursive: true });
			const payload: RulesFile = { v: RULES_VERSION, rules };
			const temporary = `${target}.tmp`;
			await writeFile(temporary, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
			await rename(temporary, target);
		},
	};
}
