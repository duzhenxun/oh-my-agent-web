/**
 * 「按会话内容让 AI 起个名」的编排层（引擎无关）。
 *
 * 分成三件事，各自都能单独测：
 *   1. 取这条会话的消息（`messagesOf`）→ 压成「谁说了什么」；
 *   2. 拼提示词 + 让引擎跑一次**一次性问答**（`suggest`，无工具、内存会话、不碰历史）；
 *   3. 清洗模型输出，落成会话名（`rename` —— 就是双击改名同一套，写进 session_info）。
 *
 * 为什么要单独一层而不塞进 runtime：这里全是「失败怎么说、兜底怎么给」的产品判断，
 * 塞进 400 行的 runtime 就再也改不动了。
 */
import type { UiMessage } from "../protocol.js";
import { buildTitlePrompt, messagesForTitle, sanitizeTitle } from "./title-prompt.js";

export type SuggestTitleResult = { ok: true; title: string } | { ok: false; error: { code: string; message: string } };

export function createTitleSuggester(deps: {
	/** 这条会话的界面消息（已加载就用内存里的，否则让引擎读转录） */
	messagesOf: (conversationId: string) => Promise<UiMessage[]>;
	/** 跑一次一次性问答，返回模型的原始输出（拿不到 / 没有可用模型时返回 null） */
	suggest: (prompt: string) => Promise<string | null>;
	/** 落盘改名（与双击改名同一个动作） */
	rename: (conversationId: string, title: string) => Promise<SuggestTitleResult>;
}): (conversationId: string) => Promise<SuggestTitleResult> {
	return async (conversationId) => {
		let messages: UiMessage[] = [];
		try {
			messages = await deps.messagesOf(conversationId);
		} catch {
			// 读转录失败不致命：下面「没有消息」那条会给出可读的提示
		}
		const transcript = messagesForTitle(messages);
		if (transcript.length === 0) {
			return { ok: false, error: { code: "session.empty", message: "这条会话还没有内容，先聊两句再让它起名" } };
		}

		let raw: string | null = null;
		try {
			raw = await deps.suggest(buildTitlePrompt(transcript));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: { code: "session.title_failed", message: `起名失败：${message}` } };
		}
		// 没有可用模型：让用户知道是「模型」的问题，而不是「起名」坏了
		if (raw === null) {
			return {
				ok: false,
				error: { code: "session.title_no_model", message: "起名需要一个可用模型，先在「模型」里配好" },
			};
		}

		const firstUser = transcript.find((message) => message.role === "user")?.text ?? "";
		return deps.rename(conversationId, sanitizeTitle(raw, firstUser));
	};
}
