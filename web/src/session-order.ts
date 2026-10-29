/**
 * 会话的**手动顺序**（`sessionPrefs.order`）—— 纯函数。
 *
 * 规则（用户 2026-10-29）：
 *   1. **手动动过的会话按手动位置排**；
 *   2. **表里没有的（没手动动过的）**：比手动段里最新那条还新的 → 排在**最上面**（新建的会话
 *      必然落这儿，用户原话：「新建的会话要放在当前项目最顶上才对」）；更老的（从归档还原、
 *      pi CLI 建的）→ 排在手动段后面，彼此之间按创建时间倒序；
 *   3. 把会话拖到别的项目里 = 搬家，落下后**默认排在那个项目的第一条**；
 *   4. 项目置顶 / 全局置顶那些数组跟这里无关（置顶另有自己的一套顺序）。
 *
 * 第 2 条为什么要「按时间分区」而不是「没排过的一律最上面」：从归档里还原一条两个月的旧会话，
 * 它同样不在表里，一律置顶的话它就会莫名其妙飞到项目最上面；按时间一分为二，新的是新的、
 * 老的回它该在的位置。也不要指望「建会话时补一条 order」把这件事办完 —— 那张表是整表覆盖写的，
 * 任何一次拿旧快照的写入都能把它冲掉（本机实测：连着建的 3 条会话全被冲掉，于是全沉到列表底下）。
 *
 * 为什么用「一个全局 id 数组 + 只比较同一项目内的相对先后」：
 *   `order` 是整表覆盖写进 settings.json 的，如果按项目拆成好几张表，
 *   每次落盘都要小心合并；而**同一个项目内的相对顺序**才是有意义的信息 ——
 *   不同项目之间的先后压根不会被比较（排序前已经按项目分好组了）。
 *   所以「重新排某个项目」时，把它的 id 按新顺序整体挪到数组最前面就行，
 *   别的项目的条目保持原有先后、跟在后面，谁的相对顺序都没被动过。
 */

/** 排序需要的最小形状（`PiSessionSummary` 天然满足） */
type SortableSession = { id: string; startedAt: number };

/** 一条会话在手动顺序里的名次：不在表里 = 无穷远（＝“没手动排过”，由 `rankSessions` 分区处理） */
function rankOf(order: readonly string[], id: string): number {
	const index = order.indexOf(id);
	return index < 0 ? Number.POSITIVE_INFINITY : index;
}

/**
 * 项目内排序，三段拼起来：
 *
 *   ① **新的、还没手动排过的**（比手动段里最新那条还新）—— 按创建时间倒序，排在最上面；
 *   ② **手动排过的** —— 按 `order` 里的先后；
 *   ③ **老的、没手动排过的** —— 按创建时间倒序，排在最后。
 *
 * ①②③ 各自内部有序，所以三趟分开排再拼，比写一个混合 comparator 好读也少出错
 * （以前那种 `Infinity - Infinity` 会得到 NaN，得靠 `||` 兜底退回按时间比）。
 */
export function rankSessions<T extends SortableSession>(sessions: readonly T[], order: readonly string[]): T[] {
	const ranked: T[] = [];
	const unranked: T[] = [];
	for (const session of sessions) {
		if (rankOf(order, session.id) === Number.POSITIVE_INFINITY) unranked.push(session);
		else ranked.push(session);
	}
	ranked.sort((a, b) => rankOf(order, a.id) - rankOf(order, b.id) || b.startedAt - a.startedAt);
	unranked.sort((a, b) => b.startedAt - a.startedAt);
	// 手动段里最新的创建时间：比它新的「没排过的」才算「新建的」，排最上面
	const newestRanked = ranked.reduce((max, session) => Math.max(max, session.startedAt), Number.NEGATIVE_INFINITY);
	const fresh = unranked.filter((session) => session.startedAt > newestRanked);
	const stale = unranked.filter((session) => session.startedAt <= newestRanked);
	return [...fresh, ...ranked, ...stale];
}

/**
 * 同项目内互换位置：把 `draggedId` 插到 `targetId` **前面**，返回该项目的新完整顺序。
 *
 * 先在现有顺序里把被拖的那条**摘掉**再插（否则会出现两条同 id）。
 * 目标不在列表里（理论上不会发生）就原样返回，不制造一个半截顺序。
 */
export function insertBefore(projectIds: readonly string[], draggedId: string, targetId: string): readonly string[] {
	if (draggedId === targetId || !projectIds.includes(targetId)) return projectIds;
	const list = projectIds.filter((id) => id !== draggedId);
	const index = list.indexOf(targetId);
	if (index < 0) return projectIds;
	list.splice(index, 0, draggedId);
	return list;
}

/**
 * 把某个项目的**新顺序**写回全局 `order`：本项目的新顺序排在最前，其余项目的条目原样跟在后面。
 *
 * `projectIds` 用「这个项目**全部**会话 id」（含归档 / 置顶的），不要只传当前渲染出来的那几条：
 * 只传可见的会把别的条目从表里静默丢掉（那些会话下次就掉回按时间排了）。
 */
export function withProjectOrder(
	order: readonly string[],
	projectIds: readonly string[],
	nextProjectOrder: readonly string[],
): string[] {
	const own = new Set(projectIds);
	const others = order.filter((id) => !own.has(id));
	return [...nextProjectOrder, ...others];
}

/**
 * 把一条会话提到**全局 `order` 的最前面**（= 它所在项目的第一条）。
 *
 * 跨项目搬家用这个：落点项目里它是第一名，用户不用再去拖一次。
 */
export function withSessionFirst(order: readonly string[], id: string): string[] {
	return [id, ...order.filter((each) => each !== id)];
}

/**
 * 新建的会话顺手记进表头（用户 2026-10-29：「新建的会话要放在最顶部」）。
 *
 * **它不负责「看得见的排序」**：那件事由 `rankSessions` 的第 ① 段自己搞定（没手动排过且比手动段新 →
 * 最上面），所以就算这张表压根没写上、或被别的写入冲掉了，新会话也不会沉下去。
 * 这里只是让表跟眼前看到的一致：接下来拖它、拖别人时，位置不会「莫名跳一下」。
 *
 * 返回 `null` = 它已经在头上了（不用写盘、也不用推一次快照）。
 */
export function promoteNewSession(order: readonly string[], id: string): string[] | null {
	return order[0] === id ? null : withSessionFirst(order, id);
}
