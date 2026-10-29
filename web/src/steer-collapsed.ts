/**
 * ADR-0041：「插队」消息的展开状态 —— **默认收起**，点一下才展开。
 *
 * 为什么默认收起：插队是回合进行中插进去的一句话，模型通常紧接着就用掉了。注入之后它会一直留在
 * 对话里（带「插队 / 已插队」标记），长会话里越堆越多 —— 而它**撤不回来**
 * （`turn-queue.ts` 的 `flushSteer` 已经把它交给引擎了，删掉气泡只会让界面和模型的上下文对不上）。
 * 所以压成一行（标签 + 首行 + 时间），想看全文点一下。
 *
 * 存的是**手动展开过**的那几条（白名单），不是"收起的"：
 *   - 默认值本来就是"收起"，白名单通常只有个位数，localStorage 不会越滚越大；
 *   - 以前默认展开、存的是"我收起的那几条"——那个键（`agent-web:steer-collapsed`）**故意不迁移**：
 *     旧记录在新语义下会把"当时收起的"读成"要展开"，正好反着。
 */
const KEY = "agent-web:steer-expanded";

/** 上限：只留**最近** 200 条 id。插队消息会一直累积，不设上限 localStorage 会慢慢变胖 */
const MAX_IDS = 200;

/** 只用到这两个方法，测试里可以传一个内存实现 */
type KeyValueStore = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

/** 解析存量：坏值（非数组/非字符串项/JSON 坏）一律丢弃，不抛错也不整份作废 */
function parseExpanded(raw: string | null): string[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const item of parsed) {
		if (typeof item !== "string" || item === "" || seen.has(item)) continue;
		seen.add(item);
		ids.push(item);
	}
	return ids;
}

/** 序列化：截到最近 MAX_IDS 条（数组尾部是最近的，见 toggleExpanded） */
function serializeExpanded(ids: Iterable<string>): string {
	return JSON.stringify([...ids].slice(-MAX_IDS));
}

/**
 * 切换一条的展开状态（在集合里 = 展开）。
 * 新加进去的放数组**末尾**：截断时丢的是最早的，用户刚点的那条不会被挤掉。
 */
export function toggleExpanded(ids: Iterable<string>, id: string): Set<string> {
	const next = new Set(ids);
	if (next.has(id)) {
		next.delete(id);
		return next;
	}
	next.add(id);
	// Set 保留插入顺序；超上限时从最早的一条开始丢
	let overflow = next.size - MAX_IDS;
	if (overflow > 0) {
		for (const old of next) {
			if (overflow-- <= 0) break;
			next.delete(old);
		}
	}
	return next;
}

/** 读整份状态（坏值当空 = 全部收起，正是默认行为） */
export function readExpanded(store: KeyValueStore): Set<string> {
	return new Set(parseExpanded(store.getItem(KEY)));
}

/** 写整份状态（空集合时写空数组，而不是删键：删键要靠 removeItem，会让实现多一个方法） */
export function writeExpanded(store: KeyValueStore, ids: Iterable<string>): void {
	store.setItem(KEY, serializeExpanded(ids));
}

/**
 * 收起那一行显示的文本：第一段非空行的开头。
 * 只取第一行是有意的 —— 插队内容常常是「一句话 + 一段补充」，收起时只需要认出是哪一条。
 */
export function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed !== "") return trimmed;
	}
	return "";
}
