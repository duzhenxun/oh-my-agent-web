/**
 * 守卫 5：协议单源（ADR-0002 纪律①、ADR-0004）。
 *
 * 线上消息规格**只能定义一处**：`server/protocol.ts`。
 * `web/src/types.ts` 是它的 shim —— 只允许「重导出」，不允许出现任何自己的声明或逻辑；
 * 否则「单源」就退化成两份会各自漂移的定义。
 *
 * 检查方式：
 *   1. `server/protocol.ts` 不存在 → 通过（M1 之前允许空实现）；
 *   2. 存在但 `web/src/types.ts` 不存在 → 违反；
 *   3. protocol.ts 里每个 `export type|interface` 名字都必须在 shim 里出现；
 *   4. shim 里每一句都必须形如 `export [type] { ... } from "..."`（多行也允许）。
 */
import { isMain, repoFileOrNull, runGuard } from "./lib/guard-kit.mjs";

export const id = "protocol-sync";
export const describe = "web/src/types.ts 与 server/protocol.ts 保持一致（ADR-0002 纪律①）";
export const PROTOCOL_PATH = "server/protocol.ts";
export const SHIM_PATH = "web/src/types.ts";

const DECL_RE = /export\s+(?:type|interface)\s+([A-Za-z0-9_]+)/g;
/** 允许的 shim 语句：重导出（含 `export type {}` 与跨行列表） */
const RE_EXPORT_STATEMENT = /^export\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']+["']$/;

/** 去掉注释（块注释 + 行注释），便于按 `;` 切分语句 */
export function stripComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export function protocolSymbols(text) {
	const declarations = [...text.matchAll(DECL_RE)].map((match) => match[1]);
	return [...new Set(declarations)];
}

/** input: { protocol: string | null, shim: string | null } */
export function inspect({ protocol, shim } = {}) {
	if (!protocol) return [];
	if (!shim) return [`${PROTOCOL_PATH} 已存在，但缺少 ${SHIM_PATH} 这个 shim`];

	const violations = [];
	for (const name of protocolSymbols(protocol)) {
		if (!new RegExp(`\\b${name}\\b`).test(shim)) {
			violations.push(`${SHIM_PATH} 未引用协议类型 ${name}（新增协议类型必须同步 shim）`);
		}
	}

	const statements = stripComments(shim)
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
	if (statements.length === 0) violations.push(`${SHIM_PATH} 里没有任何重导出语句`);
	for (const statement of statements) {
		if (!RE_EXPORT_STATEMENT.test(statement)) {
			violations.push(`${SHIM_PATH} 只能重导出协议定义，出现了其他语句：${statement.slice(0, 80)}`);
		}
	}
	return violations;
}

export function collect() {
	return { protocol: repoFileOrNull(PROTOCOL_PATH), shim: repoFileOrNull(SHIM_PATH) };
}

const PROTOCOL_FIXTURE = `
export type ClientMessage = { id: string; type: "send_message" };
export interface Snapshot { protocolVersion: number }
`;

const GOOD_SHIM = `
export type { ClientMessage, Snapshot } from "../../server/protocol.ts";
`;

export const selfTests = [
	{ name: "protocol.ts 还不存在时放行", input: { protocol: null, shim: null }, shouldFail: false },
	{ name: "缺 shim 应变红", input: { protocol: PROTOCOL_FIXTURE, shim: null }, shouldFail: true },
	{
		name: "shim 漏了协议类型应变红",
		input: { protocol: PROTOCOL_FIXTURE, shim: 'export type { Snapshot } from "../../server/protocol.ts";' },
		shouldFail: true,
	},
	{
		name: "shim 自己又定义了一份类型应变红（单源被破坏）",
		input: {
			protocol: PROTOCOL_FIXTURE,
			shim: 'export type { ClientMessage, Snapshot } from "../../server/protocol.ts";\nexport type Extra = { a: 1 };',
		},
		shouldFail: true,
	},
	{
		name: "shim 里写逻辑（非重导出的语句）应变红",
		input: {
			protocol: PROTOCOL_FIXTURE,
			shim: 'export type { ClientMessage, Snapshot } from "../../server/protocol.ts";\nconst x = 1;',
		},
		shouldFail: true,
	},
	{
		name: "干净的纯重导出 shim 应通过（含跨行列表）",
		input: { protocol: PROTOCOL_FIXTURE, shim: GOOD_SHIM },
		shouldFail: false,
	},
];

const guard = { id, describe, inspect, collect, selfTests };
if (isMain(import.meta.url)) runGuard(guard);
