/**
 * 切换会话（从 runtime.ts 抽出：400 行护栏）。
 *
 * 两件事必须一起做：
 *   1. 记下「这个客户端在看哪」—— 多标签/多设备各看各的（ADR-0033）；
 *   2. 更新全局 activeId 与 files.root —— `stats` / `models` / `files` 目前按全局会话算，
 *      不更新就会出现「token 面板空、模型未就绪、文件树停在旧目录」。
 */
import type { UiMessage } from "../protocol.js";
import type { ServerState } from "../snapshot/state.js";
import type { ClientView } from "./client-view.js";

type SwitchDeps = {
	state: ServerState;
	clientView: ClientView;
	infoOf: (conversationId: string) => { workspace: string } | null;
	open: (conversationId: string, refresh: (force: boolean) => Promise<void>) => Promise<UiMessage[] | null>;
	refreshSessions: (force: boolean) => Promise<void>;
	refreshModels: (conversationId: string) => Promise<void>;
	refreshThinking: (conversationId: string) => Promise<void>;
	/** 刷新某条会话的统计（不传则刷当前活跃会话） */
	refreshStats: (conversationId?: string) => void;
	/** 上一个会话不再看了：让引擎放开写锁（codex）；有回合在跑时不调用 */
	parkPrevious: (conversationId: string) => void;
	/**
	 * 这条会话是不是正在跑回合。
	 *
	 * 打开历史会话会 `readUiMessages` 整份覆盖 `state.messages[conv]`，而正在跑的那一轮
	 * 把「当前用户消息 + 占位的 assistant 消息」放在同一个数组里，靠 messageId 接增量事件。
	 * 覆盖之后事件全对不上 → 正文 / 工具卡 / 思考**都不再更新**，如果引擎阅读回空数组，
	 * 连刚发的那条用户消息一起消失（就是「跑着跑着右边空了」，用户 2026-10-30）。
	 */
	isTurnActive?: (conversationId: string) => boolean;
	pushSnapshot: () => void;
	/**
	 * 诊断日志：切会话到底慢在哪一步。
	 *
	 * 没有这行数字时只能猜 —— 「打开会话 / 读整份转录」「模型与思考强度回读」「快照构建」
	 * 三步的耗时量级完全不同（手机 + 长会话上前者动辄几百毫秒），但界面上都只是「点了没反应」。
	 */
	log?: (message: string, ctx?: Record<string, unknown>) => void;
};

type Result = { ok: true } | { ok: false; error: { code: string; message: string } };

export function createSwitchConversation(deps: SwitchDeps) {
	const { state, clientView } = deps;

	async function switchTo(conversationId: string, clientId?: string): Promise<Result> {
		const startedAt = performance.now();
		let cursor = startedAt;
		const trace: Record<string, number> = {};
		/** 记一段耗时并把游标挪到当下：纯观测，不改变任何行为 */
		const lap = (name: string) => {
			const now = performance.now();
			trace[name] = Math.round(now - cursor);
			cursor = now;
		};
		/** 失败分支也要落一行：否则「点了没反应」时只有一句 not_found，看不到时间花在哪 */
		const logDone = (outcome: string, extra: Record<string, unknown> = {}) => {
			deps.log?.("切换会话", {
				conversationId,
				outcome,
				total: Math.round(performance.now() - startedAt),
				...trace,
				...extra,
			});
		};
		const previous = state.activeId;
		const mine = state.conversations.some((conversation) => conversation.id === conversationId);
		const fromPi = deps.infoOf(conversationId);
		// 先校验再动状态：以前 parkPrevious / 清建议 / 改客户端视图都在校验之前，
		// 点一条已删除的会话会把**当前**会话停泊掉（codex 放开写锁）、建议被清空，
		// 而界面还停在错误提示上 —— 副作用全白做了。
		if (!mine && !fromPi) {
			logDone("not_found");
			return { ok: false, error: { code: "session.not_found", message: `会话不存在：${conversationId}` } };
		}
		if (previous && previous !== conversationId) {
			deps.parkPrevious(previous);
			// 建议按会话各存一份：切走**不用清**，切回来还是那批（以前全局一份，切走只能清掉）
		}
		// 每个客户端各记一份视图（互不影响）
		if (clientId) clientView.setActive(clientId, conversationId);
		// 统计先换成本会话的缓存（没有就清空）：refreshStats 是异步的，不先换的话
		// 这一帧快照里还是**上一个会话**的 token 数（新会话看着像"有记录"）。
		state.sessionStats = state.statsByConversation[conversationId] ?? null;

		if (!mine && fromPi) {
			// 「这次是不是真的重新打开了」——已经是当前会话且消息已在内存时不重读，是最快的一条路
			const reopened = state.activeId !== conversationId || !state.messages[conversationId];
			if (reopened) {
				const messages = await deps.open(conversationId, (force) => deps.refreshSessions(force));
				lap("open");
				if (messages === null) {
					logDone("open_failed");
					return { ok: false, error: { code: "session.open_failed", message: `打开会话失败：${conversationId}` } };
				}
				/**
				 * 这一轮还在跑就别拿转录覆盖内存：转录里是**上一次落盘的**内容，
				 * 覆盖会把在飞的用户消息和占位 assistant 一起顶掉（见 `isTurnActive` 的注释）。
				 * 只把它当“补历史”用：内存里一条都没有时（刚重启 / 没加载过）才整份采用。
				 */
				const inFlight = deps.isTurnActive?.(conversationId) ?? false;
				const current = state.messages[conversationId];
				if (!inFlight || !current || current.length === 0) state.messages[conversationId] = messages;
				await deps.refreshModels(conversationId);
				lap("models");
				await deps.refreshThinking(conversationId);
				lap("thinking");
				state.activeId = conversationId;
				state.files = { root: fromPi.workspace, treeVersion: (state.files?.treeVersion ?? 0) + 1 };
			}
			/**
			 * 这类会话不在本进程的 conversations 里，统计从来没算过（`mine` 分支的 refreshStats 走不到这里）。
			 * 不刷的话 statsByConversation 里没有它 → 快照里 sessionStats 为 null → 上下文一直显示 0。
			 */
			deps.refreshStats(conversationId);
			// 无论有没有真的换（已是当前会话也推）：客户端靠这份快照把乐观高亮退掉，
			// 否则点一下当前会话就变成「正在打开…」卡在那里 —— 看着就是「点了没反应」。
			deps.pushSnapshot();
			lap("build");
			logDone("ok", {
				mine: false,
				reopened,
				messages: state.messages[conversationId]?.length ?? 0,
			});
			return { ok: true };
		}
		if (state.activeId !== conversationId) {
			state.activeId = conversationId;
			// 自建会话也要给出文件根，否则文件树一直是空的
			const workspace = state.conversations.find((item) => item.id === conversationId)?.workspace;
			if (workspace && state.files?.root !== workspace) {
				state.files = { root: workspace, treeVersion: (state.files?.treeVersion ?? 0) + 1 };
			}
			// 模型选择器是全局一份，切会话必须把「这个会话当前用哪个模型」读回来，
			// 否则会一直显示上一个会话的模型（看着就像「选的模型没生效」）。
			await deps.refreshModels(conversationId);
			lap("models");
			// 思考强度也是「每个会话一份」：自建会话同样要读回来，否则切来切去显示的是上一个会话的
			await deps.refreshThinking(conversationId);
			lap("thinking");
		}
		// 这里只是**发起**统计重算（读整份 JSONL 是异步的），所以这一格只反映调用本身；
		// 真正的解析耗时会在快照偏慢/偏大的那条日志里体现
		deps.refreshStats();
		lap("stats");
		// 同一个理由：已经是当前会话也要推一份，客户端才知道「切到了」。
		deps.pushSnapshot();
		lap("build");
		logDone("ok", { mine: true, messages: state.messages[conversationId]?.length ?? 0 });
		return { ok: true };
	}

	return switchTo;
}
