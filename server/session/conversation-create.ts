/**
 * 新建会话（ADR-0021 §2 收尾）——从 runtime 抽出（ADR-0010 的 400 行护栏）。
 *
 * 顺序讲究，所以集中一处：
 *   1. 用我们的 id 建 SDK 会话（文件落在 pi 的会话存储里，与 pi CLI 共用）；
 *   2. 在 opener 里登记（立刻可切、可发消息，不必等扫描回来）；
 *   3. 在内存里补一条会话元数据（侧栏立刻可见；扫描回来后以磁盘为准）。
 */
import type { EnginePort } from "../engine/port.js";
import type { ConversationMeta, UiMessage } from "../protocol.js";
import type { PiSessionOpener } from "./pi-opener.js";

export type ConversationFactory = {
	/** workspace = 在哪个项目下新建（不传则继承当前会话/当前工作区） */
	create: (seedText: string, workspaceOverride?: string) => Promise<string>;
};

export function createConversationFactory(options: {
	state: {
		conversations: ConversationMeta[];
		messages: Record<string, UiMessage[]>;
		activeId: string | null;
		/** 界面上当前选中的模型（新会话要沿用它，否则选择器显示的和实际跑的不是一个） */
		model: string | null;
		workspace: string;
		files: { root: string; treeVersion: number } | null;
		/** 建议不跟着新会话走（ADR-0022 §建议的生命周期） */
		actions: import("../protocol.js").ActionItem[];
		/** 会话统计（新会话要清零，否则第一帧带着上一个会话的上下文用量） */
		sessionStats: import("../protocol.js").SessionStats | null;
	};
	engine: EnginePort;
	opener: PiSessionOpener;
	nextId: (prefix: string) => string;
	/** 新会话的 id（默认 UUID，与 pi 一致；测试注入确定性 id） */
	newConversationId: () => string;
	now: () => number;
	titleChars: number;
	/** 这个项目该用哪个模型起头（runtime 给：显式默认 → 该项目最近用过的） */
	defaultModelFor?: (workspace: string) => string | null;
	/** 新会话就绪后回调（runtime 用它拉模型列表） */
	onReady?: (conversationId: string) => Promise<void> | void;
}): ConversationFactory {
	return {
		async create(seedText: string, workspaceOverride?: string) {
			const { state } = options;
			const id = options.newConversationId();
			// 新会话沿用「当前会话/当前工作区」的目录（多项目：不把新会话丢回默认根）
			const previousWorkspace = state.activeId
				? state.conversations.find((item) => item.id === state.activeId)?.workspace
				: undefined;
			// 优先级：显式指定（项目行上的「+」）> 当前会话的目录 > 当前工作区
			const workspace = workspaceOverride ?? previousWorkspace ?? state.files?.root ?? state.workspace;
			const title = seedText.replace(/\s+/g, " ").trim().slice(0, options.titleChars) || "新对话";

			const { sessionPath, engineSessionId } = await options.engine.createSession({ sessionId: id, workspace });
			// SDK 建会话时用的是**引擎默认模型**，必须显式切一下，否则就是「选的 A、跑的 B」。
			// 优先级：本项目的默认模型（用户设过）> 本项目最近一个会话用的 > 界面上选着的
			const wanted = options.defaultModelFor?.(workspace) ?? state.model;
			if (wanted) {
				const switched = (await options.engine.switchModel?.(id, wanted)) ?? false;
				if (switched)
					state.model = wanted; // 选择器跟着真值走
				else {
					// 切不过去（模型被删/没鉴权）：让选择器回到真实值，别继续骗人
					const current = (await options.engine.currentModel?.(id)) ?? null;
					state.model = current ? `${current.provider}/${current.model}` : null;
				}
			}
			options.opener.register({ id, sessionPath, engineSessionId, title, workspace });
			state.messages[id] = [];
			state.conversations = [
				{ id, title, createdAt: options.now(), updatedAt: options.now(), workspace, messageCount: 0 },
				...state.conversations,
			];
			state.activeId = id;
			// 新会话从 0 开始：不先把统计清掉，第一帧快照还会带着上一个会话的上下文用量
			state.sessionStats = null;
			state.actions = []; // 建议不跟着新会话走
			state.files = { root: workspace, treeVersion: (state.files?.treeVersion ?? 0) + 1 };
			await options.onReady?.(id);
			return id;
		},
	};
}

/**
 * 「新建会话」这个请求的处理（含错误归一化）。
 *
 * 从 runtime 抽出来：新建会话要顺带把**发起者自己的视图**指过去（ADR-0033），
 * 这几句放回 runtime 会破 400 行护栏。
 */
export function newConversationWith(deps: {
	create: (seedText: string, workspace?: string) => Promise<string>;
	clientView: { setActive: (clientId: string, conversationId: string) => void };
	notice: (text: string, level: "info" | "warn" | "error") => void;
	pushSnapshot: () => void;
}) {
	return async (workspace?: string, clientId?: string) => {
		try {
			const id = await deps.create("新对话", workspace);
			// 每个客户端各记各的视图：不把发起者的指过来，它收到的快照仍是旧会话
			if (clientId) deps.clientView.setActive(clientId, id);
			deps.pushSnapshot(); // ← 少了这一句，侧栏不会更新（冒烟抓到过）
			return { ok: true as const };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.notice(`新建会话失败：${message}`, "error");
			return { ok: false as const, error: { code: "session.create_failed", message } };
		}
	};
}
