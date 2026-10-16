/**
 * 建议操作标记（ADR-0022）：解析、剥离、归约。
 * 全部是纯函数 —— 标记来自模型文本，必须假设它会写坏（截断、嵌套、中文逗号、超长）。
 */
import { describe, expect, it } from "vitest";
import {
	applyMarkersToMessage,
	createMarkerStreamFilter,
	MAX_ACTIONS,
	MAX_PENDING_CHARS,
	parseActionMarkers,
	reduceActionMarkers,
	stripMarkers,
} from "../../server/markers/actions.js";
import type { ActionItem } from "../../server/protocol.js";

const ids = () => {
	let n = 0;
	return () => `act-${++n}`;
};

describe("parseActionMarkers", () => {
	it("解析基本形式", () => {
		expect(parseActionMarkers("[[action:suggest:继续]]")).toEqual([{ kind: "suggest", label: "继续", prompt: "继续" }]);
	});

	it("label 与 prompt 分离", () => {
		expect(parseActionMarkers("[[action:suggest:继续第 2 步,prompt=按 A 方案继续]]")).toEqual([
			{ kind: "suggest", label: "继续第 2 步", prompt: "按 A 方案继续" },
		]);
	});

	it("支持别名（action:next / suggest）", () => {
		expect(parseActionMarkers("[[action:next:下一步]]")[0]).toMatchObject({ label: "下一步" });
		expect(parseActionMarkers("[[suggest:下一步]]")[0]).toMatchObject({ label: "下一步" });
	});

	it("clear 清空", () => {
		expect(parseActionMarkers("[[action:clear:all]]")).toEqual([{ kind: "clear" }]);
	});

	it("不认识的命名空间不动（普通双括号不该被吃掉）", () => {
		expect(parseActionMarkers("[[todo:add:写文档]]")).toEqual([]);
		expect(parseActionMarkers("[[某个链接]]")).toEqual([]);
	});

	it("畸形标记被忽略而不是报错", () => {
		expect(parseActionMarkers("[[action:suggest:]]")).toEqual([]);
		expect(parseActionMarkers("[[action:unknown:xxx]]")).toEqual([]);
		expect(parseActionMarkers("[[]]")).toEqual([]);
	});

	it("超长 label 被截断到 80 字", () => {
		const long = "x".repeat(200);
		const parsed = parseActionMarkers(`[[action:suggest:${long}]]`);
		expect(parsed[0]).toMatchObject({ label: "x".repeat(80) });
	});

	it("一条文本里多个标记按顺序解析", () => {
		const parsed = parseActionMarkers("先做 A。\n[[action:suggest:A]]\n[[action:suggest:B]]");
		expect(parsed.map((token) => (token.kind === "suggest" ? token.label : "clear"))).toEqual(["A", "B"]);
	});
});

describe("stripMarkers", () => {
	it("剥离标记并清理留下的空行", () => {
		expect(stripMarkers("干完了。\n\n[[action:suggest:继续]]")).toBe("干完了。");
	});

	it("保留正文，只去掉标记", () => {
		expect(stripMarkers("看这里 [[action:suggest:继续]] 后面还有字")).toBe("看这里  后面还有字");
	});

	it("只剥认识的命名空间", () => {
		expect(stripMarkers("[[todo:add:x]] 保留")).toBe("[[todo:add:x]] 保留");
	});

	it("流式期间剥掉未闭合的尾部标记", () => {
		expect(stripMarkers("结果如下：[[action:su", { stripTrailingIncomplete: true })).toBe("结果如下：");
		expect(stripMarkers("结果如下：[[action:su")).toBe("结果如下：[[action:su");
	});

	it("没有标记时原样返回（不做多余处理）", () => {
		expect(stripMarkers("普通文本")).toBe("普通文本");
	});
});

describe("reduceActionMarkers", () => {
	it("归约出干净文本与建议项", () => {
		const result = reduceActionMarkers("干完了。[[action:suggest:继续]]", [], ids());
		expect(result.text).toBe("干完了。");
		expect(result.actions).toEqual([{ id: "act-1", label: "继续", prompt: "继续" }]);
	});

	it("去重（同一 label+prompt 不重复加）", () => {
		const first = reduceActionMarkers("[[action:suggest:继续]]", [], ids());
		const second = reduceActionMarkers("[[action:suggest:继续]]", first.actions, ids());
		expect(second.actions).toHaveLength(1);
	});

	it("上限 8 条，超出丢最早", () => {
		const current: ActionItem[] = Array.from({ length: MAX_ACTIONS }, (_, index) => ({
			id: `old-${index}`,
			label: `旧 ${index}`,
			prompt: `旧 ${index}`,
		}));
		const result = reduceActionMarkers("[[action:suggest:新的]]", current, ids());
		expect(result.actions).toHaveLength(MAX_ACTIONS);
		expect(result.actions.at(-1)?.label).toBe("新的");
		expect(result.actions.some((item) => item.label === "旧 0")).toBe(false);
	});

	it("clear 清空已有建议", () => {
		const current: ActionItem[] = [{ id: "a", label: "A", prompt: "A" }];
		expect(reduceActionMarkers("[[action:clear:all]]", current, ids()).actions).toEqual([]);
	});

	it("没有标记时保持原样（文本与建议都不动）", () => {
		const current: ActionItem[] = [{ id: "a", label: "A", prompt: "A" }];
		const result = reduceActionMarkers("普通回复", current, ids());
		expect(result.text).toBe("普通回复");
		expect(result.actions).toBe(current);
	});
});

describe("applyMarkersToMessage", () => {
	it("剥掉文本块里的标记，工具卡保持原位", () => {
		const message = {
			blocks: [
				{ kind: "text" as const, text: "先读文件：" },
				{
					kind: "tool" as const,
					toolCallId: "t1",
					name: "read",
					argsSummary: "a.ts",
					status: "ok" as const,
					outputExcerpt: "内容",
					truncated: false,
					startedAt: 1,
				},
				{ kind: "text" as const, text: "读完了。[[action:suggest:继续]]" },
			],
		};
		const result = applyMarkersToMessage(message, [], ids());
		// 合并后的文本放在**第一个文本块的位置**（保序的最合理近似）：text("先读文件："+ "读完了。") 然后在原位保留工具卡
		expect((result.blocks as Array<{ kind: string; text?: string }>).map((block) => block.kind)).toEqual([
			"text",
			"tool",
		]);
		expect((result.blocks[0] as { text: string }).text).toBe("先读文件：读完了。");
		expect(result.actions).toHaveLength(1);
	});

	it("没有标记时原样返回（不做无谓的对象重建）", () => {
		const message = { blocks: [{ kind: "text" as const, text: "普通" }] };
		expect(applyMarkersToMessage(message, [], ids()).blocks).toBe(message.blocks);
	});

	it("只有标记没有正文时不留空文本块", () => {
		const message = { blocks: [{ kind: "text" as const, text: "[[action:suggest:继续]]" }] };
		const result = applyMarkersToMessage(message, [], ids());
		expect(result.blocks).toEqual([]);
		expect(result.actions).toHaveLength(1);
	});
});

describe("流式过滤器（ADR-0022）：标记不能漏到界面上", () => {
	it("标记被拆成多个 chunk 也不会漏出来", () => {
		const filter = createMarkerStreamFilter();
		let out = "";
		for (const chunk of ["干完了。", "\n[[act", "ion:sugg", "est:继续]]", "\n"]) out += filter.push(chunk);
		out += filter.flush();
		// 流式期间只保证「不漏语法」：标记丢掉后可能留下空行（渲染上是不可见的）
		expect(out).toBe("干完了。\n\n");
		expect(out).not.toContain("[[");
	});

	it("普通文本立即吐出（不做无谓的缓冲）", () => {
		const filter = createMarkerStreamFilter();
		expect(filter.push("普通文本")).toBe("普通文本");
		expect(filter.flush()).toBe("");
	});

	it("不认识的命名空间照样显示（与 stripMarkers 一个口径）", () => {
		const filter = createMarkerStreamFilter();
		let out = filter.push("[[todo:add:写文档]]");
		out += filter.flush();
		expect(out).toBe("[[todo:add:写文档]]");
	});

	it("未闭合的尾巴被扣住，flush 时吐出来", () => {
		const filter = createMarkerStreamFilter();
		expect(filter.push("结果：[[action:su")).toBe("结果：");
		expect(filter.flush()).toBe("[[action:su");
	});

	it("正文里超长的未闭合双括号不会被卡死", () => {
		const filter = createMarkerStreamFilter();
		const chunk = `[[ ${"x".repeat(MAX_PENDING_CHARS + 50)}`;
		expect(filter.push(chunk)).toBe(chunk);
	});

	it("闭合后不是标记的方括号按普通文本补上", () => {
		const filter = createMarkerStreamFilter();
		let out = filter.push("看 [[这个是普通括号]] 结束");
		out += filter.flush();
		expect(out).toBe("看 [[这个是普通括号]] 结束");
	});

	it("多个标记连着写也都能丢掉", () => {
		const filter = createMarkerStreamFilter();
		let out = filter.push("好了[[action:suggest:继续]][[action:suggest:停]]");
		out += filter.flush();
		expect(out).toBe("好了");
	});
});

describe("流式过滤器的边界：两个方括号被拆开", () => {
	it("「[」与「[action:...」分属两个 chunk 时也不漏", () => {
		const filter = createMarkerStreamFilter();
		let out = filter.push("好了[");
		out += filter.push("[action:suggest:继续]]");
		out += filter.flush();
		expect(out).toBe("好了");
	});

	it("单个孤立的方括号在回合结束时会还回来", () => {
		const filter = createMarkerStreamFilter();
		const out = filter.push("数组下标 a[") + filter.flush();
		expect(out).toBe("数组下标 a[");
	});
});
