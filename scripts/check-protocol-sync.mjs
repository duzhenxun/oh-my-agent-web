/**
 * 守卫 5：协议单源（ADR-0002 纪律①、ADR-0004）。
 *
 * 线上消息规格**只能定义一处**：`server/protocol.ts`。
 * `web/src/types.ts` 是它的 shim（只允许重导出/别名，不允许自己定义一份）。
 *
 * 本守卫的检查方式（刻意保持简单可读）：
 *   1. `server/protocol.ts` 不存在 → 通过（M1 之前允许空实现）；
 *   2. 存在但 `web/src/types.ts` 不存在 → 违反；
 *   3. protocol.ts 里每个 `export type|interface X` 与每个消息字面量 `type: "snake_case"`
 *      都必须在 shim 里出现（重导出或引用）。
 */
import { isMain, repoFileOrNull, runGuard } from "./lib/guard-kit.mjs";

export const id = "protocol-sync";
export const describe = "web/src/types.ts 与 server/protocol.ts 保持一致（ADR-0002 纪律①）";
export const PROTOCOL_PATH = "server/protocol.ts";
export const SHIM_PATH = "web/src/types.ts";

const DECL_RE = /export\s+(?:type|interface)\s+([A-Za-z0-9_]+)/g;
const MESSAGE_RE = /type:\s*"([a-z0-9_]+)"/g;

export function protocolSymbols(text) {
	const declarations = [...text.matchAll(DECL_RE)].map((match) => match[1]);
	const messages = [...text.matchAll(MESSAGE_RE)].map((match) => match[1]);
	return { declarations: [...new Set(declarations)], messages: [...new Set(messages)] };
}

/** input: { protocol: string | null, shim: string | null } */
export function inspect({ protocol, shim } = {}) {
	if (!protocol) return [];
	if (!shim) return [`${PROTOCOL_PATH} 已存在，但缺少 ${SHIM_PATH} 这个 shim`];

	const { declarations, messages } = protocolSymbols(protocol);
	const violations = [];
	for (const name of declarations) {
		if (!new RegExp(`\\b${name}\\b`).test(shim)) {
			violations.push(`${SHIM_PATH} 未引用协议类型 ${name}（新增协议类型必须同步 shim）`);
		}
	}
	for (const message of messages) {
		if (!shim.includes(message)) {
			violations.push(`${SHIM_PATH} 未引用消息 ${message}（新增消息必须同步 shim）`);
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

export const selfTests = [
	{ name: "protocol.ts 还不存在时放行（M1 之前）", input: { protocol: null, shim: null }, shouldFail: false },
	{ name: "缺 shim 应变红", input: { protocol: PROTOCOL_FIXTURE, shim: null }, shouldFail: true },
	{
		name: "shim 漏了消息字面量应变红",
		input: {
			protocol: PROTOCOL_FIXTURE,
			shim: 'export type { ClientMessage, Snapshot } from "../../server/protocol.ts";',
		},
		shouldFail: true,
	},
	{
		name: "shim 完整时应通过",
		input: {
			protocol: PROTOCOL_FIXTURE,
			shim: 'export type { ClientMessage, Snapshot } from "../../server/protocol.ts";\nconst SEND = "send_message";\nvoid SEND;',
		},
		shouldFail: false,
	},
];

const guard = { id, describe, inspect, collect, selfTests };
if (isMain(import.meta.url)) runGuard(guard);
