/**
 * 「插队」消息的展开状态（`web/src/steer-collapsed.ts`）的纯函数测试。
 *
 * 默认是**收起**，所以这里存的是"用户手动展开过的那几条"（白名单）。两条纪律：
 *   1. 空集合 = 全部收起（默认值不依赖任何存储）；
 *   2. 存储边界必须容错 —— localStorage 里可能是旧版本写的、手改的、别的分支写的，
 *      一条坏记录不能把整个对话渲染带崩。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	firstLine,
	parseExpanded,
	readExpanded,
	serializeExpanded,
	toggleExpanded,
	writeExpanded,
	type KeyValueStore,
} from "../../web/src/steer-collapsed.ts";

const memoryStore = (initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } => {
	const data = { ...initial };
	return {
		data,
		getItem: (key) => (key in data ? (data[key] ?? null) : null),
		setItem: (key, value) => {
			data[key] = value;
		},
	};
};

test("parseExpanded：坏值一律当空，不抛错", () => {
	assert.deepEqual(parseExpanded(null), []);
	assert.deepEqual(parseExpanded(""), []);
	assert.deepEqual(parseExpanded("不是 JSON"), []);
	assert.deepEqual(parseExpanded('{"id":"x"}'), []); // 非数组
	assert.deepEqual(parseExpanded('["a",1,null,"","a"]'), ["a"]); // 非字符串 / 空串 / 重复
});

test("toggleExpanded：加了再去掉", () => {
	const once = toggleExpanded([], "m1");
	assert.deepEqual([...once], ["m1"]);
	const twice = toggleExpanded(once, "m1");
	assert.deepEqual([...twice], []);
});

test("toggleExpanded：超上限丢最早的，刚点的那条一定留下", () => {
	let ids: Set<string> = new Set();
	for (let i = 0; i < 200; i += 1) ids = toggleExpanded(ids, `m${i}`);
	assert.equal(ids.size, 200);
	ids = toggleExpanded(ids, "newest");
	assert.equal(ids.size, 200);
	assert.equal(ids.has("m0"), false, "最早的应被丢掉");
	assert.equal(ids.has("newest"), true, "刚展开的那条不能被丢");
	assert.equal(ids.has("m199"), true);
});

test("serializeExpanded：截到最近 200 条（数组尾部最新）", () => {
	const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
	const parsed = JSON.parse(serializeExpanded(ids)) as string[];
	assert.equal(parsed.length, 200);
	assert.equal(parsed[0], "m50");
	assert.equal(parsed[199], "m249");
});

test("读写往返：写进去的能读回来", () => {
	const store = memoryStore();
	writeExpanded(store, ["m1", "m2"]);
	const back = readExpanded(store);
	assert.deepEqual([...back], ["m1", "m2"]);
});

test("readExpanded：坏值 → 空集合（= 全部收起，是默认行为）", () => {
	assert.equal(readExpanded(memoryStore({ "agent-web:steer-expanded": "[[[" })).size, 0);
	// 老键（以前存的是"我收起的那几条"）不再读：避免把旧意图反着执行
	assert.equal(readExpanded(memoryStore({ "agent-web:steer-collapsed": '["m1"]' })).size, 0);
});

test("firstLine：取第一段非空行，跳过开头的空行", () => {
	assert.equal(firstLine("\n\n  淡淡的颜色 偏蓝色那种\n第二行"), "淡淡的颜色 偏蓝色那种");
	assert.equal(firstLine("   "), "");
	assert.equal(firstLine(""), "");
});
