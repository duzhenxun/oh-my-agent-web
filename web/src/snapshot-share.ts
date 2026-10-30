/**
 * 快照的**结构共享**（identity 复用）：服务端每帧都是一份全新 JSON，原样塞进 store 就等于
 * 整棵树都换成新对象 —— 前端所有 `memo` / 引用比较全部失效，表现是「一帧快照 = 整屏重渲染 +
 * 每条消息的 Markdown 重新解析」，长对话（尤其是纯内存的临时会话）里就是明显的打字卡顿。
 *
 * 所以应用快照之前先做一次深比较：**内容没变的分支直接沿用上一份的引用**，
 * 内容变了的那一条才换新对象。数据一个字节都不改，只是让「相等」在引用上也能看出来。
 *
 * 为什么放在客户端而不是让服务端做 diff：服务端要面对多个客户端、各自的会话视图不同；
 * 这里只比较「我这一个连接上一帧 vs 这一帧」，最简单也最准。
 */

/** 纯 JSON 对象（快照就是 JSON：不带原型、不是数组、不是类实例） */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** 深度复用：`previous` 与 `next` 内容相同就返回 `previous`，不同则返回 `next`（不修改任何一方） */
function shareValue<T>(previous: unknown, next: T): T {
	if (Object.is(previous, next)) return next;

	if (Array.isArray(previous) && Array.isArray(next)) {
		// 长度不同 = 必然变了（多一条消息、少一个项目），直接给新的
		if (previous.length !== next.length) return next as T;
		let changed = false;
		const merged = next.map((item, index) => {
			const shared = shareValue(previous[index], item);
			// 「变了」= 这一格没能沿用旧引用。拿旧值比，不是拿新值比：
			// 深相等时 `shared` 正是 `previous[index]`，拿 `item` 比会把「复用」误判成「变化」。
			if (shared !== previous[index]) changed = true;
			return shared;
		});
		return (changed ? merged : previous) as T;
	}

	if (isPlainRecord(previous) && isPlainRecord(next)) {
		const nextKeys = Object.keys(next);
		// 键集不同（增删字段）= 变了
		if (nextKeys.length !== Object.keys(previous).length) return next;
		let changed = false;
		const merged: Record<string, unknown> = {};
		for (const key of nextKeys) {
			if (!Object.hasOwn(previous, key)) return next;
			const shared = shareValue(previous[key], next[key]);
			merged[key] = shared;
			// 同上：跟旧值比，才分得清「复用了」与「真的变了」
			if (shared !== previous[key]) changed = true;
		}
		return (changed ? merged : previous) as T;
	}

	return next;
}

/**
 * 把新快照跟上一份对齐：内容未变的部分复用旧引用，变了的部分用新值。
 * 没有上一份时（首次连接 / 换了会话后清空）直接原样返回。
 */
export function shareSnapshot<T>(previous: T | null | undefined, next: T): T {
	if (previous === null || previous === undefined) return next;
	return shareValue(previous, next);
}
