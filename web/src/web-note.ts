/**
 * 右侧面板里**网页**的「标注」：指出网页上的哪一处要改，把这条意见送进对话输入框。
 *
 * 两块纯逻辑（不碰 DOM、不碰 React）：
 *   1. 解析 iframe 里那段拾取脚本（`server/web-proxy/picker-script.ts`）发回来的消息 ——
 *      **一律当作不可信输入**：那个 window 里也跑着别人的页面脚本，它同样能发这种消息；
 *   2. 一条标注 → 能接进草稿的一段文字。
 *
 * 为什么不直接改草稿：见 `WebTool` 那一侧 —— 先摆进输入条给人看一眼再确认，
 * 不让人在打字的时候被网页塞进来的东西抢走输入。
 */

/** 拾取脚本报回来的元素信息（都来自网页自己，所以每条都要过一遍类型检查） */
export type WebSpot = {
	/** 拾取时那一页的地址 */
	url: string;
	/** CSS 选择器（脚本按「唯一 id 优先、否则往上拼」算出来的） */
	selector: string;
	/** 标签名（`button` / `img` …） */
	tag: string;
	/** aria-label / placeholder / alt 之类能认出元素的短标签，可为空 */
	label: string;
	/** 元素里那点可见文字（已压平、截断），可为空 */
	text: string;
};

/** 拾取到的一处（老名字：它就是脚本发回来的那一包东西） */
export type WebPick = WebSpot;

/** 一条完整的网页标注 = 位置 + 我要改什么 */
export type WebNote = WebSpot & { comment: string };

/**
 * 一条网页标注 + **它在页面上的编号**（1, 2, 3, 4…）。
 *
 * 编号是「这一页上第几个被标的地方」，由面板按拾取顺序发，**不发回也不重号**：
 * 标过的位置在页面上一直挂着那个号（包括已经进了输入框、甚至已经发出去的），
 * 所以下一次标的是 4、5…，而不是又从 1 开始。
 */
export type WebNoteWithNumber = WebNote & { number: number };

/** iframe → 父窗口 的几种消息（父窗口只处理这些，别的一律丢掉） */
export type WebPickerEvent =
	/** 用户在**页面上就地**写完了这一条（`comment` 可为空） */
	| { kind: "note"; note: WebNote }
	/** 只选中了某一处、还没写（旧版脚本的写法，留着不至于整条丢掉） */
	| { kind: "picked"; pick: WebPick }
	| { kind: "ready"; url: string }
	/** 页面看着是空的（正文没字、也没有一屏看得见的图）：大概是在面板里没跑起来 */
	| { kind: "blank"; url: string }
	| { kind: "exit" };

/** 备注里的文字最长留这么多：再长就不是「一句意见」，是把整段内容贴进来了 */
const MAX_TEXT = 80;

function str(value: unknown, limit = 400): string {
	if (typeof value !== "string") return "";
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > limit ? flat.slice(0, limit) : flat;
}

/** 压平、去空白、超长截断（截断处留一个省略号，看得出是被截的） */
export function clipText(value: string, limit = MAX_TEXT): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 选择器必须能当行内代码写进 markdown：反引号会把整段格式带偏，直接换成 `'` */
function safeSelector(value: string): string {
	return clipText(value.replace(/`/g, "'"), 240);
}

/**
 * iframe 发来的一条消息 → 我们认识的事件（不认识返回 null）。
 *
 * 这里挡的是「形状不对」而不是「来源不对」：来源由调用方拿 `event.source` 校验
 * （`event.origin` 在沙箱 iframe 里恒为 `"null"`，靠它认不出是谁）。
 */
export function readPickerEvent(data: unknown): WebPickerEvent | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	if (message.__aw !== "picker") return null;
	if (message.type === "ready") return { kind: "ready", url: str(message.url, 2000) };
	if (message.type === "blank") return { kind: "blank", url: str(message.url, 2000) };
	if (message.type === "exit") return { kind: "exit" };
	if (message.type !== "picked" && message.type !== "note") return null;
	// 没有选择器就等于「不知道标的是哪儿」：这种消息留着只会往列表里塞一条空注释
	const selector = safeSelector(str(message.selector, 400));
	if (selector === "") return null;
	const pick: WebPick = {
		url: str(message.url, 2000),
		selector,
		tag: str(message.tag, 40),
		label: clipText(str(message.label, 200)),
		text: clipText(str(message.text, 200)),
	};
	if (message.type === "note") return { kind: "note", note: { ...pick, comment: str(message.comment, 2000) } };
	return { kind: "picked", pick };
}

/**
 * 位置那几行（不含标题、不含评论）：选择器 + 元素。
 *
 * 单独导出是为了让「N 条注释」的批量列表能给它換一个标题（`标注 3（网页 http://…）：`）
 * 而不用把同一套拼法再写一遍 —— 两处格式一跑偏，同一批标注看起来就像两回事。
 */
export function webSpotLines(spot: WebSpot): string[] {
	const lines: string[] = [];
	const selector = safeSelector(spot.selector);
	if (selector !== "") lines.push(`位置：\`${selector}\``);
	const kind = spot.tag.trim();
	const label = spot.label.trim();
	const text = spot.text.trim();
	// 「元素」这一行按有的信息拼：标签名 + 能认出它的短标签 / 可见文字
	const labels: string[] = [];
	if (label !== "" && label !== text) labels.push(`「${label}」`);
	if (text !== "" && text !== label) labels.push(`「${text}」`);
	const element = `${kind}${labels.join(" ")}`;
	if (element !== "") lines.push(`元素：${element}`);
	return lines;
}

/** 地址那一句（单独一节时是标题的尾巴，批量里是括号里的那个 url） */
export function webUrlText(spot: WebSpot): string {
	return spot.url.trim();
}

/**
 * 一条网页标注 → 可以直接接进草稿的一段。
 *
 * 形状跟 `annotations.ts` 里那块保持一致（「标注 N：」那套的兄弟）：
 * 先交代**在哪儿**（地址 + 选择器 + 元素标签），空一行，再写**要改什么**。
 * 选择器用行内代码包起来：模型一眼能看出那是一段选择器，而不是普通句子。
 * 空一行是有意的 —— 上面是位置、下面是意见，粘在一起容易读成「选择器就是这个意思」。
 */
export function webNoteBlock(note: WebNote): string {
	const url = webUrlText(note);
	const head = [url === "" ? "网页标注" : `网页标注：${url}`, ...webSpotLines(note)].join("\n");
	const comment = note.comment.trim();
	return comment === "" ? head : `${head}\n\n${comment}`;
}
