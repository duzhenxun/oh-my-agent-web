/**
 * 建议标记的 body 解析（`[[action:suggest:按钮文字,prompt=完整指令]]`）。
 *
 * 回归点是一个线上真问题：模型写的按钮文字里也带逗号，
 * 旧实现按逗号切分，于是「按钮上直接显示了 prompt=…」，中文逗号还整段解析不出来。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRefreshActionsPrompt, reduceActionMarkers } from "../../server/markers/actions.ts";

let seq = 0;
const parseOne = (raw: string) => {
	const out = reduceActionMarkers(raw, [], () => `id-${++seq}`);
	return out.actions[0];
};

describe("suggest 标记的 label / prompt 拆分", () => {
	it("英文逗号：prompt= 之后的逗号内容不能被丢掉", () => {
		const action = parseOne(
			"[[action:suggest:接着刷灰度仲夏爱恋, prompt=新 token 是 xxx, 刷灰度 act202402_user_draw2 的 A/B/C 奖池]]",
		);
		assert.equal(action?.label, "接着刷灰度仲夏爱恋");
		assert.equal(action?.prompt, "新 token 是 xxx, 刷灰度 act202402_user_draw2 的 A/B/C 奖池");
	});

	it("中文逗号同样要认（旧实现整段当成按钮文字）", () => {
		const action = parseOne(
			"[[action:suggest:接着刷灰度仲夏爱恋，prompt=新 token 是 xxx，刷灰度 act202402_user_draw2 的 A/B/C 奖池]]",
		);
		assert.equal(action?.label, "接着刷灰度仲夏爱恋");
		assert.equal(action?.prompt, "新 token 是 xxx，刷灰度 act202402_user_draw2 的 A/B/C 奖池");
	});

	it("按钮文字里绝不能出现 prompt=", () => {
		const action = parseOne("[[action:suggest:检查配置，prompt=看两个环境的 draw_gold 是否一致]]");
		assert.ok(action?.label);
		assert.doesNotMatch(action.label, /prompt\s*=/);
	});

	it("显式 label 优先于前面的文字", () => {
		const action = parseOne("[[action:suggest:按钮文案,label=显示文字,prompt=发送内容]]");
		assert.equal(action?.label, "显示文字");
		assert.equal(action?.prompt, "发送内容");
	});

	it("只有按钮文字时，发送内容与它相同", () => {
		const action = parseOne("[[action:suggest:继续]]");
		assert.equal(action?.label, "继续");
		assert.equal(action?.prompt, "继续");
	});

	it("别名 [[suggest:…]] 仍然可用", () => {
		const action = parseOne("[[suggest:直接给文字]]");
		assert.equal(action?.label, "直接给文字");
		assert.equal(action?.prompt, "直接给文字");
	});

	it("空标签被忽略（模型照抄示例不会冒假建议）", () => {
		assert.equal(parseOne("[[action:suggest:]]"), undefined);
	});
});

describe("想想 的指令", () => {
	it("明确要求按钮文字里不要写 prompt=", () => {
		const prompt = buildRefreshActionsPrompt([], 4);
		assert.match(prompt, /不要.*prompt=/);
		assert.match(prompt, /\[\[action:suggest:/);
	});
});
