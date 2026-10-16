/**
 * 引擎会话的生命周期（ADR-0018）——从 runtime 拆出来的第二个职责（ADR-0010 的 400 行护栏逼出来的）。
 *
 * 它解决的是 M3 手工运行时踩到的真 bug：**引擎会话是进程内的，而对话是持久的**。
 * 于是「重启后再打开旧会话发消息」必然失败（`engine.no_session`），
 * 并且即使重建了会话，不喂历史模型也会失忆。
 *
 * 两条规则：
 *   1. 懒创建：第一次要用（发消息）时才建，避免切换列表时把资源扫描跑满；
 *   2. 建的时候带上**已有历史**（宿主转录 → 引擎条目的纯文本形式）。
 */
import type { EngineMessage, EnginePort } from "../engine/port.js";
import type { UiMessage } from "../protocol.js";

/** 纯函数：把界面消息转成引擎历史（只取文本；工具卡与错误块不进历史，对连续性价值低、形状复杂） */
export function messagesToHistory(messages: UiMessage[]): EngineMessage[] {
	return messages
		.map((message) => ({
			role: message.role,
			text: message.blocks.map((block) => (block.kind === "text" ? block.text : "")).join(""),
			ts: message.ts,
		}))
		.filter((message) => message.text.trim() !== "");
}

export type EngineBindingOptions = {
	engine: EnginePort;
	workspace: string;
	/** 宿主侧消息（用于注入历史） */
	messagesOf: (conversationId: string) => UiMessage[];
	/** 拿到当前模型时回调（用于快照显示） */
	onModel?: (model: { provider: string; model: string }) => void;
};

export type EngineBinding = {
	/** 确保引擎里有这个会话（幂等） */
	ensure: (conversationId: string) => Promise<void>;
	/** 忘掉（会话创建失败要回滚时用） */
	forget: (conversationId: string) => void;
	has: (conversationId: string) => boolean;
	/** 进程内已建了几个（测试与诊断用） */
	count: () => number;
};

export function createEngineBinding(options: EngineBindingOptions): EngineBinding {
	const bound = new Set<string>();

	return {
		async ensure(conversationId) {
			if (bound.has(conversationId)) return;
			await options.engine.createSession({
				sessionId: conversationId,
				workspace: options.workspace,
				history: messagesToHistory(options.messagesOf(conversationId)),
			});
			bound.add(conversationId);

			const model = (await options.engine.currentModel?.(conversationId)) ?? null;
			if (model) options.onModel?.(model);
		},

		forget(conversationId) {
			bound.delete(conversationId);
		},

		has: (conversationId) => bound.has(conversationId),

		count: () => bound.size,
	};
}
