/**
 * 「标注」的两块纯逻辑（`web/src/annotation-anchor.ts` + `web/src/annotations.ts`）。
 *
 * 钉住四件容易写错的事：
 *   1. 存的是「文字 + 前后上下文」，所以同一句话在回复里出现两次时，能靠上下文认出是哪一处；
 *   2. 两头空白要 trim，偏移跟着走（鼠标拖选常多带一个换行）；
 *   3. 找不到就返回 null —— 不能把标注硬贴到别的地方去；
 *   4. localStorage 里的坏数据丢一条是一条，不能让整个列表失效。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureAnchor, locateAnchor } from "../../web/src/annotation-anchor.ts";
import {
	addAnnotation,
	annotationNumber,
	annotationsAsMessage,
	annotationsOf,
	markQuoted,
	parseAnnotations,
	removeAnnotation,
	setAnnotationComment,
	type Annotation,
} from "../../web/src/annotations.ts";

describe("captureAnchor", () => {
	it("切出原样文字，两头各带一段上下文", () => {
		const flat = "前面的话。要标的这句。后面的话。";
		const anchor = captureAnchor(flat, 5, 11);
		assert.deepEqual(anchor, {
			exact: "要标的这句。",
			prefix: "前面的话。",
			suffix: "后面的话。",
		});
	});

	it("两头空白 trim 掉（偏移跟着走，不影响 exact）", () => {
		const flat = "abc  目标  def";
		const anchor = captureAnchor(flat, 3, 9);
		assert.equal(anchor?.exact, "目标");
		// 上下文照原样留着（trim 只收 exact 的边，不动上下文：留着空白更好对位）
		assert.equal(anchor?.prefix, "abc  ");
		assert.equal(anchor?.suffix, "  def");
	});

	it("在开头 / 结尾时没有上下文，是空串而不是 undefined", () => {
		const anchor = captureAnchor("整段都是选中的", 0, 7);
		assert.deepEqual(anchor, { exact: "整段都是选中的", prefix: "", suffix: "" });
	});

	it("纯空白选区 → null（没有文字的标注没意义）", () => {
		assert.equal(captureAnchor("a   b", 1, 3), null);
		assert.equal(captureAnchor("abc", 1, 1), null);
	});

	it("越界的偏移被夹住，不会抛异常", () => {
		const anchor = captureAnchor("abc", -5, 999);
		assert.equal(anchor?.exact, "abc");
	});
});

describe("locateAnchor", () => {
	it("正常找回（前后都在）", () => {
		const flat = "开头。目标句子。结尾。";
		const anchor = captureAnchor(flat, 3, 8);
		assert.deepEqual(locateAnchor(flat, anchor as never), { start: 3, end: 8 });
	});

	it("同一句话出现两次：靠上下文挑对那一处", () => {
		const flat = "第一处：这里要说清楚。第二处：这里要说清楚。";
		// 标的是第二处
		const second = flat.lastIndexOf("这里要说清楚。");
		const anchor = captureAnchor(flat, second, second + "这里要说清楚。".length);
		assert.ok(anchor);
		assert.deepEqual(locateAnchor(flat, anchor), { start: second, end: second + "这里要说清楚。".length });
	});

	it("消息变长（前面多了一段）之后仍然对得上", () => {
		const before = "开头。目标句子。结尾。";
		const anchor = captureAnchor(before, 3, 8);
		assert.ok(anchor);
		const after = "后来插入的一大段。还有一段。" + before;
		const found = locateAnchor(after, anchor);
		assert.equal(found === null ? null : after.slice(found.start, found.end), "目标句子。");
	});

	it("上下文对不上了（结构重排 / 空白变了）也回到原样文字的第一处", () => {
		const anchor = { exact: "目标句子", prefix: "完全不存在的上文", suffix: "也不存在的下文" };
		const flat = "无关开头 目标句子 无关结尾";
		assert.deepEqual(locateAnchor(flat, anchor), { start: 5, end: 9 });
	});

	it("那句话被删了就返回 null（不硬贴到别处）", () => {
		const anchor = { exact: "已经被删掉的话", prefix: "", suffix: "" };
		assert.equal(locateAnchor("完全不同的正文", anchor), null);
	});

	it("空 exact → null", () => {
		assert.equal(locateAnchor("abc", { exact: "", prefix: "", suffix: "" }), null);
	});
});

const sample = (id: string, exact: string, comment = ""): Annotation => ({
	id,
	messageId: "m1",
	anchor: { exact, prefix: "前", suffix: "后" },
	comment,
	createdAt: 1,
});

describe("parseAnnotations", () => {
	it("坏一条丢一条，其余照常读出来", () => {
		const raw = JSON.stringify([
			{ id: "a", messageId: "m1", anchor: { exact: "x", prefix: "", suffix: "" }, comment: "", createdAt: 1 },
			{ id: "b", anchor: { exact: "y" } }, // 缺 messageId
			{ id: "c", messageId: "m1", anchor: {} }, // 缺 exact
			"不是对象",
			null,
		]);
		const list = parseAnnotations(raw);
		assert.equal(list.length, 1);
		assert.equal(list[0]?.id, "a");
	});

	it("不是 JSON / 不是数组 / 空 → 空列表（不抛）", () => {
		assert.deepEqual(parseAnnotations("{坏 json"), []);
		assert.deepEqual(parseAnnotations('{"a":1}'), []);
		assert.deepEqual(parseAnnotations(null), []);
		assert.deepEqual(parseAnnotations(""), []);
	});

	it("缺 createdAt / comment 的老数据给默认值", () => {
		const list = parseAnnotations(
			JSON.stringify([{ id: "a", messageId: "m1", anchor: { exact: "x", prefix: "", suffix: "" } }]),
		);
		assert.equal(list[0]?.comment, "");
		assert.equal(list[0]?.createdAt, 0);
	});
});

describe("addAnnotation", () => {
	it("不同位置的标注往后加，编号按顺序", () => {
		let list = addAnnotation([], sample("a", "第一处"));
		list = addAnnotation(list, sample("b", "第二处"));
		assert.deepEqual(
			list.map((item) => item.id),
			["a", "b"],
		);
	});

	it("同一处再标一次 = 改评论，不叠第二个编号", () => {
		let list = addAnnotation([], sample("a", "同一句", "旧评论"));
		list = addAnnotation(list, sample("b", "同一句", "新评论"));
		assert.equal(list.length, 1);
		assert.equal(list[0]?.id, "a");
		assert.equal(list[0]?.comment, "新评论");
	});

	it("同一句话、上下文不同 = 两处标注（各自一个编号）", () => {
		let list = addAnnotation([], sample("a", "这里要说清楚"));
		list = addAnnotation(list, {
			...sample("b", "这里要说清楚"),
			anchor: { exact: "这里要说清楚", prefix: "另", suffix: "段" },
		});
		assert.equal(list.length, 2);
	});
});

describe("removeAnnotation / annotationNumber / annotationsOf", () => {
	it("删掉之后编号重排（编号 = 列表第几条）", () => {
		let list = addAnnotation([], sample("a", "第一处"));
		list = addAnnotation(list, sample("b", "第二处"));
		list = removeAnnotation(list, "a");
		assert.equal(annotationNumber(list, "b"), 1);
		assert.equal(annotationNumber(list, "a"), 0);
	});

	it("按消息过滤", () => {
		const list = [sample("a", "x"), { ...sample("b", "y"), messageId: "m2" }];
		assert.deepEqual(
			annotationsOf(list, "m2").map((item) => item.id),
			["b"],
		);
	});
});

describe("annotationsAsMessage", () => {
	it("没有标注 → 空串（发送按钮据此保持灰的）", () => {
		assert.equal(annotationsAsMessage([]), "");
	});

	it("一条：编号行 + 引用块 + 空一行 + 评论，末尾不留空行", () => {
		assert.equal(annotationsAsMessage([sample("a", "这段话", "改一下")]), "标注 1：\n> 这段话\n\n改一下");
	});

	it("没写评论的那条只发编号 + 引用块", () => {
		assert.equal(annotationsAsMessage([sample("a", "这段话")]), "标注 1：\n> 这段话");
	});

	it("多条按列表顺序编号，块与块之间空一行", () => {
		assert.equal(
			annotationsAsMessage([sample("a", "第一处", "评论一"), sample("b", "第二处")]),
			"标注 1：\n> 第一处\n\n评论一\n\n标注 2：\n> 第二处",
		);
	});

	it("编号紧贴引用块（不在中间空行），多行原文逐行加引用符", () => {
		assert.equal(annotationsAsMessage([sample("a", "上\n下")]), "标注 1：\n> 上\n> 下");
	});

	it("已「放进输入框」的那条不再追加（否则同一段发两次），但编号不重排", () => {
		const list = markQuoted([sample("a", "第一处", "评论一"), sample("b", "第二处")], "a");
		// 原文已经在草稿里了，只剩第二条；编号仍是 2（跟正文里那个徽标对得上）
		assert.equal(annotationsAsMessage(list), "标注 2：\n> 第二处");
		// 全都放进了输入框 → 没有要追加的东西
		assert.equal(annotationsAsMessage(markQuoted(list, "b")), "");
	});
});

describe("setAnnotationComment / markQuoted", () => {
	it("改一条的评论，别的行不受影响", () => {
		const list = setAnnotationComment([sample("a", "第一处"), sample("b", "第二处")], "b", "这里要改");
		assert.equal(list[0]?.comment, "");
		assert.equal(list[1]?.comment, "这里要改");
	});

	it("id 不在列表里 → 原样返回（不抛错）", () => {
		const list = [sample("a", "第一处")];
		assert.deepEqual(setAnnotationComment(list, "nope", "x"), list);
		assert.deepEqual(markQuoted(list, "nope"), list);
	});
});
