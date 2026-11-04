/**
 * 「网页标注」（`web/src/web-note.ts`）+ 代理注入（`server/web-proxy/rewrite.ts`）。
 *
 * 钉住四件容易写错的事：
 *   1. iframe 发回来的消息**不可信**（那个 window 里跑着别人的页面脚本），形状不对就整条丢掉；
 *   2. 没有选择器的「标注」等于不知道标在哪儿 —— 宁可丢，也不要往草稿里塞一句空话；
 *   3. 选择器里的反引号会把 markdown 行内代码带偏，必须先换掉；
 *   4. 代理文档里必须真的带上拾取脚本，不然 📍 在页面里点不动。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readPickerEvent, webNoteBlock, type WebNote } from "../../web/src/web-note.ts";
import {
	addAnnotation,
	annotationBlock,
	annotationNumber,
	annotationsAsMessage,
	isWebAnnotation,
	markQuoted,
	parseAnnotations,
	type Annotation,
} from "../../web/src/annotations.ts";
import { rewriteHtml } from "../../server/web-proxy/rewrite.ts";
import { appendBlock } from "../../web/src/selection-quote.ts";
import { proxyUrlOf, targetOfProxyUrl } from "../../web/src/url-bar.ts";
import {
	addWebMark,
	marksOfPage,
	nextNumberFor,
	parseWebMarks,
	readWebMarks,
	removePageMarks,
	writeWebMarks,
} from "../../web/src/web-marks.ts";

const NOTE: WebNote = {
	url: "http://localhost:3000/list",
	selector: "main > ul.rows:nth-of-type(2) > li:nth-of-type(3) > button.buy",
	tag: "button",
	label: "",
	text: "立即购买",
	comment: "把这个按钮的文案改成「立即下单」",
};

describe("readPickerEvent", () => {
	it("认下正常的一条并压平空白", () => {
		const event = readPickerEvent({
			__aw: "picker",
			type: "picked",
			url: " http://localhost:3000/a ",
			selector: "  div >  button.buy ",
			tag: "BUTTON",
			label: " 立即购买 ",
			text: "立即\n购买",
		});
		assert.deepEqual(event, {
			kind: "picked",
			pick: {
				url: "http://localhost:3000/a",
				selector: "div > button.buy",
				tag: "BUTTON",
				label: "立即购买",
				text: "立即 购买",
			},
		});
	});

	it("没有选择器 / 不是我们家的消息 → null", () => {
		assert.equal(readPickerEvent({ __aw: "picker", type: "picked", selector: "   " }), null);
		assert.equal(readPickerEvent({ __aw: "other", type: "picked", selector: "div" }), null);
		assert.equal(readPickerEvent(null), null);
		assert.equal(readPickerEvent("picked"), null);
	});

	it("ready / exit / 未知类型", () => {
		assert.deepEqual(readPickerEvent({ __aw: "picker", type: "ready", url: "http://x/" }), {
			kind: "ready",
			url: "http://x/",
		});
		assert.deepEqual(readPickerEvent({ __aw: "picker", type: "exit" }), { kind: "exit" });
		assert.equal(readPickerEvent({ __aw: "picker", type: "whatever" }), null);
	});

	it("反引号不能活着进 markdown", () => {
		const event = readPickerEvent({ __aw: "picker", type: "picked", selector: "div[data-x='a`b']" });
		assert.equal(event?.kind, "picked");
		assert.equal(event?.kind === "picked" && event.pick.selector.includes("`"), false);
	});

	it("超长文字截断并留省略号", () => {
		const event = readPickerEvent({ __aw: "picker", type: "picked", selector: "div", text: "字".repeat(300) });
		assert.equal(event?.kind, "picked");
		const text = event?.kind === "picked" ? event.pick.text : "";
		assert.equal(text.endsWith("…"), true);
		assert.equal(text.length, 81);
	});
});

describe("webNoteBlock", () => {
	it("地址 + 选择器 + 元素 + 意见", () => {
		assert.equal(
			webNoteBlock(NOTE),
			[
				"网页标注：http://localhost:3000/list",
				"位置：`main > ul.rows:nth-of-type(2) > li:nth-of-type(3) > button.buy`",
				"元素：button「立即购买」",
				"",
				"把这个按钮的文案改成「立即下单」",
			].join("\n"),
		);
	});

	it("没写意见时只留位置（这条标注本身就是「指出这一处」）", () => {
		const block = webNoteBlock({ ...NOTE, comment: "   " });
		assert.equal(block.includes("立即下单"), false);
		assert.equal(block.endsWith("元素：button「立即购买」"), true);
	});

	it("label 与可见文字相同时不重复写两遍", () => {
		const block = webNoteBlock({ ...NOTE, label: "立即购买", text: "立即购买" });
		assert.equal(block.includes("「立即购买」「立即购买」"), false);
	});

	it("地址 / 选择器缺了也不至于产出空行", () => {
		const block = webNoteBlock({ ...NOTE, url: "", selector: "", tag: "", text: "", label: "", comment: "" });
		assert.equal(block, "网页标注");
	});
});

describe("appendBlock", () => {
	it("空草稿直接放进去，前后留白", () => {
		assert.equal(appendBlock("", "块"), "块\n\n");
	});

	it("已有草稿接在后面，不清掉原来的字", () => {
		assert.equal(appendBlock("我在说的是另一件事", "块"), "我在说的是另一件事\n\n块\n\n");
	});
});

describe("代理注入", () => {
	it("文档里带上拾取脚本（带 head 与不带 head 都塞得进去）", () => {
		const scope = { scheme: "http", host: "localhost:3000" };
		const withHead = rewriteHtml("<html><head><title>t</title></head><body>x</body></html>", scope);
		assert.equal(withHead.includes("__awPicker"), true);
		// 塞在 head 开头：页面自己的脚本跑起来之前就挂好监听了
		assert.equal(withHead.indexOf("__awPicker") < withHead.indexOf("<title>"), true);
		const bare = rewriteHtml("<div>x</div>", scope);
		assert.equal(bare.includes("__awPicker"), true);
	});

	it("拾取中不许跳转：跳转脚本要给标注让路", () => {
		const html = rewriteHtml("<html><head></head><body><a href=/b>x</a></body></html>", {
			scheme: "http",
			host: "localhost:3000",
		});
		// 两段注入都在，且「点击跳转」那段会先看标注是否开着
		assert.equal(html.includes("__awPicking"), true);
		const navStart = html.indexOf('document.addEventListener("click"');
		assert.equal(navStart > 0, true);
		assert.equal(html.slice(navStart, navStart + 220).includes("if(window.__awPicking) return;"), true);
	});
});

describe("网页标注并进注释列表（批量）", () => {
	const SPOT = {
		url: "http://localhost:3000/list",
		selector: "button.buy",
		tag: "button",
		label: "",
		text: "立即购买",
	};
	const messageNote = (id: string, exact: string): Annotation => ({
		id,
		messageId: "m1",
		anchor: { exact, prefix: "", suffix: "" },
		comment: "",
		createdAt: 1,
	});

	it("网页标注能存进 localStorage 再读回来（对话里那种老数据也不受影响）", () => {
		const raw = JSON.stringify([
			messageNote("a", "第一句"),
			{ id: "web:1", kind: "web", number: 1, spot: SPOT, comment: "改成下单", createdAt: 2 },
		]);
		const list = parseAnnotations(raw);
		assert.equal(list.length, 2);
		const second = list[1];
		assert.equal(isWebAnnotation(list[0] as Annotation), false);
		assert.ok(second !== undefined && isWebAnnotation(second));
		assert.equal(second.spot.selector, "button.buy");
		assert.equal(second.comment, "改成下单");
		assert.equal(second.number, 1);
	});

	it("坏掉的网页标注一条一条丢，好的一条不留后遗症", () => {
		const raw = JSON.stringify([
			{ id: "w1", kind: "web", spot: { selector: "" } },
			{ id: "w2", kind: "web" },
			{ id: "w3", kind: "???", messageId: "m1", anchor: { exact: "x" } },
			{ id: "w4", kind: "web", number: 6, spot: { url: "http://x/", selector: "div.a" } },
		]);
		assert.deepEqual(
			parseAnnotations(raw).map((item) => item.id),
			["w4"],
		);
	});

	it("同一页同一个选择器再标 = 改那一句，不叠第二个编号", () => {
		const first = addAnnotation([], {
			id: "w1",
			kind: "web",
			number: 1,
			spot: SPOT,
			comment: "旧的意见",
			createdAt: 1,
		});
		const next = addAnnotation(first, {
			id: "w2",
			kind: "web",
			number: 2,
			spot: SPOT,
			comment: "新的意见",
			createdAt: 2,
		});
		assert.equal(next.length, 1);
		assert.equal(next[0]?.id, "w1");
		assert.equal(next[0]?.comment, "新的意见");
	});

	it("编号跨两种标注连续，批量发出去时各说各的位置", () => {
		const web: Annotation = { id: "w1", kind: "web", number: 1, spot: SPOT, comment: "改成下单", createdAt: 1 };
		const list: Annotation[] = [messageNote("a", "第一句"), web];
		assert.equal(annotationBlock(list[0] as Annotation, 1), "标注 1：\n> 第一句");
		// 网页标注用它自己在页面上的号（这里是 1），不是「列表里排第几」
		assert.equal(
			annotationBlock(web, 2),
			"标注 1（网页 http://localhost:3000/list）：\n位置：`button.buy`\n元素：button「立即购买」\n\n改成下单",
		);
		const body = annotationsAsMessage(list);
		assert.equal(body.includes("标注 1："), true);
		assert.equal(body.includes("标注 1（网页"), true);
	});

	it("已经「放进输入框」的那条不会被批量再发一遍", () => {
		const web: Annotation = { id: "w1", kind: "web", number: 1, spot: SPOT, comment: "", createdAt: 1 };
		const body = annotationsAsMessage(markQuoted([messageNote("a", "第一句"), web], "w1"));
		assert.equal(body.includes("button.buy"), false);
		assert.equal(body.includes("标注 1"), true);
	});
});

describe("代理地址 → 原网址（前端那份反向换算）", () => {
	it("转回原网址：标了几处的判断与写进注释的地址都靠它", () => {
		// 注意不含 `#锚点`：代理路径里本来就不带它（`proxyUrlOf` 只拼 path + search），
		// 所以「代理一趟再回来」丢掉的只是 hash —— 这也正是 iframe 里 `location.href` 的样子
		const cases = [
			"http://127.0.0.1:8799/",
			"https://www.baidu.com/s?wd=hello%20world&ie=utf-8",
			"http://localhost:3000/a/b.html?x=1",
			"https://github.com/duzhenxun/oh-my-agent-web/pulls",
		];
		for (const target of cases) {
			const proxied = proxyUrlOf(target);
			assert.ok(proxied, `拼不出代理地址：${target}`);
			// iframe 里 `location.href` 报的是「本机源 + 代理路径」，这里按那个形状还原
			const asInFrame = new URL(proxied as string, "http://127.0.0.1:8898/").toString();
			assert.equal(targetOfProxyUrl(asInFrame), target);
		}
	});

	it("不是代理地址 / 协议不对 → null（调用方原样用）", () => {
		assert.equal(targetOfProxyUrl("http://127.0.0.1:8898/"), null);
		assert.equal(targetOfProxyUrl("http://127.0.0.1:8898/web/p/ftp/example.com/a"), null);
		assert.equal(targetOfProxyUrl("http://127.0.0.1:8898/web/p/"), null);
		assert.equal(targetOfProxyUrl("不是网址"), null);
	});
});

describe("页面上的号：进过输入框/已经发出去的也保留", () => {
	const spot = { url: "http://localhost:3000/list", selector: "button.buy", tag: "button", label: "", text: "" };

	it("网页标注用它在页面上的号，不是列表下标", () => {
		const list: Annotation[] = [
			{ id: "a", messageId: "m1", anchor: { exact: "x", prefix: "", suffix: "" }, comment: "", createdAt: 1 },
			{ id: "w9", kind: "web", number: 9, spot, comment: "第九处", createdAt: 2 },
		];
		// 在列表里它排第二，但页面上写的是 9 —— 发出去也必须是 9
		assert.equal(annotationNumber(list, "w9"), 9);
		assert.equal(annotationNumber(list, "a"), 1);
		assert.equal(
			annotationBlock(list[1] as Annotation, 2).startsWith("标注 9（网页 http://localhost:3000/list）："),
			true,
		);
	});

	it("老数据没有 number 时退回列表下标（不至于显示 0）", () => {
		const list: Annotation[] = [{ id: "w", kind: "web", number: 0, spot, comment: "", createdAt: 1 }];
		assert.equal(annotationNumber(list, "w"), 1);
		assert.equal(annotationBlock(list[0] as Annotation, 1).startsWith("标注 1（网页"), true);
	});

	it("同一处再标只改意见，号不变", () => {
		const first = addAnnotation([], { id: "w1", kind: "web", number: 4, spot, comment: "旧的", createdAt: 1 });
		const next = addAnnotation(first, { id: "w2", kind: "web", number: 5, spot, comment: "新的", createdAt: 2 });
		assert.equal(next.length, 1);
		assert.equal(annotationNumber(next, "w1"), 4);
		// 号写在注释身上，重新标同一处不会把它冲掉
		assert.ok(isWebAnnotation(next[0] as Annotation) && (next[0] as { number: number }).number === 4);
	});
});

describe("页面标记落盘（web-marks.ts）", () => {
	/** 内存里的假 Storage：只测「存进去 / 读出来」这条链 */
	function fakeStorage(): Storage & { raw: Map<string, string> } {
		const raw = new Map<string, string>();
		return {
			raw,
			get length() {
				return raw.size;
			},
			clear: () => raw.clear(),
			getItem: (key: string) => raw.get(key) ?? null,
			key: (index: number) => [...raw.keys()][index] ?? null,
			removeItem: (key: string) => void raw.delete(key),
			setItem: (key: string, value: string) => void raw.set(key, value),
		} as Storage & { raw: Map<string, string> };
	}
	const PAGE = "http://localhost:3000/list";
	const OTHER = "http://localhost:3000/other";

	it("存进去再读回来：选择器、意见、号都在（浏览器重启靠它）", () => {
		const storage = fakeStorage();
		const marks = addWebMark(addWebMark([], { url: PAGE, selector: "button.buy", comment: "改文案" }), {
			url: PAGE,
			selector: "#only",
			comment: "",
		});
		writeWebMarks(storage, marks);
		const back = readWebMarks(storage);
		assert.deepEqual(
			back.map((mark) => [mark.number, mark.selector, mark.comment]),
			[
				[1, "button.buy", "改文案"],
				[2, "#only", ""],
			],
		);
	});

	it("号按页发：另一页从 1 开始，本页接着 3", () => {
		let marks = addWebMark([], { url: PAGE, selector: "a", comment: "" });
		marks = addWebMark(marks, { url: PAGE, selector: "b", comment: "" });
		marks = addWebMark(marks, { url: OTHER, selector: "a", comment: "" });
		assert.equal(nextNumberFor(marks, PAGE), 3);
		assert.equal(nextNumberFor(marks, OTHER), 2);
		assert.deepEqual(
			marksOfPage(marks, PAGE).map((mark) => mark.number),
			[1, 2],
		);
	});

	it("同一处再标：号不变，只换那句意见", () => {
		const first = addWebMark([], { url: PAGE, selector: "a", comment: "旧的" });
		const next = addWebMark(first, { url: PAGE, selector: "a", comment: "新的" });
		assert.equal(next.length, 1);
		assert.equal(nextNumberFor(next, PAGE), 2);
		assert.equal(next[0]?.comment, "新的");
	});

	it("坏数据丢一条是一条；位置不全的整条丢", () => {
		const list = parseWebMarks(
			JSON.stringify([
				{ number: 1, url: PAGE, selector: "a" },
				{ number: 2, url: PAGE },
				{ number: 3, selector: "c" },
				"nope",
				{ number: 4, url: PAGE, selector: "d", comment: 5 },
			]),
		);
		assert.deepEqual(
			list.map((mark) => [mark.number, mark.selector, mark.comment]),
			[
				[1, "a", ""],
				[4, "d", ""],
			],
		);
		assert.deepEqual(parseWebMarks("{坏"), []);
	});

	it("清空某一页：别的页不受影响", () => {
		let marks = addWebMark([], { url: PAGE, selector: "a", comment: "" });
		marks = addWebMark(marks, { url: OTHER, selector: "b", comment: "" });
		const next = removePageMarks(marks, PAGE);
		assert.deepEqual(
			next.map((mark) => mark.url),
			[OTHER],
		);
		// 清完再标又是第 1 处
		assert.equal(nextNumberFor(next, PAGE), 1);
	});

	it("写空就等于删键（不留一堆空数组）", () => {
		const storage = fakeStorage();
		writeWebMarks(storage, [{ number: 1, url: PAGE, selector: "a", comment: "", createdAt: 1 }]);
		assert.equal(storage.raw.size, 1);
		writeWebMarks(storage, []);
		assert.equal(storage.raw.size, 0);
	});
});
