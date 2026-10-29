/**
 * Claude ACP 适配器的默认可执行文件探测（`server/engine/claude-transport.ts`）。
 *
 * 这个适配器改过名：老包 `@zed-industries/claude-code-acp` 出 `claude-code-acp`，
 * 新包 `@agentclientprotocol/claude-agent-acp` 出 `claude-agent-acp`。
 * 只认一个名字的话，用户按 deprecation 提示装完新包反而会「找不到适配器」，所以两个都认。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_ACP_BINS, defaultClaudeBin } from "../../server/engine/claude-transport.ts";

const env = { PATH: "/usr/bin:/opt/bin" } as NodeJS.ProcessEnv;

/** 伪造 PATH 命中表：只认识 given 里列出的名字 */
const finder =
	(...present: string[]) =>
	(bin: string) =>
		present.includes(bin) ? `/opt/bin/${bin}` : null;

test("两个名字都认：只装了老包时用 claude-code-acp", () => {
	assert.equal(defaultClaudeBin(env, finder("claude-code-acp")), "claude-code-acp");
});

test("两个名字都认：只装了改名后的新包时用 claude-agent-acp", () => {
	assert.equal(defaultClaudeBin(env, finder("claude-agent-acp")), "claude-agent-acp");
});

test("两个都装了优先老名字（保持既有机器上的行为不变）", () => {
	assert.equal(defaultClaudeBin(env, finder(...CLAUDE_ACP_BINS)), "claude-code-acp");
});

test("一个都没装时回落到老名字：错误信息里教的就是这个包的装法", () => {
	assert.equal(
		defaultClaudeBin(env, () => null),
		"claude-code-acp",
	);
});
