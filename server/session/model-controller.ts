/**
 * 模型列表与切换（ADR-0020 §P2）——从 runtime 抽出（400 行护栏）。
 *
 * 列表来自引擎的注册表（只列**已配置鉴权**的模型），切换写进会话文件（SDK 的 model_change），
 * 所以「续聊时模型不变」是它自带的性质，不需要我们额外持久化。
 *
 * 拿不到列表时保持空数组（界面退回只读芯片）—— 不编造默认值，也不阻塞主流程。
 */
import type { EnginePort } from "../engine/port.js";
import type { ModelOption, ProtocolError } from "../protocol.js";

export type Result = { ok: true } | { ok: false; error: ProtocolError };

export type ModelController = {
	/** 会话就绪后拉一次（best-effort） */
	refresh: (conversationId: string) => Promise<void>;
	/** 切换当前会话的模型 */
	switchTo: (conversationId: string | null, modelId: string) => Promise<Result>;
};

export function createModelController(options: {
	engine: EnginePort;
	state: { model: string | null; models: ModelOption[] };
	notice: (text: string, level: "info" | "warn" | "error") => void;
	onChanged: () => void;
}): ModelController {
	return {
		async refresh(conversationId) {
			try {
				const list = (await options.engine.listModels?.(conversationId)) ?? [];
				options.state.models = list.map((model) => ({ id: model.id, label: model.label }));
			} catch {
				options.state.models = [];
			}
		},

		async switchTo(conversationId, modelId) {
			if (!conversationId) return { ok: false, error: { code: "session.none", message: "先打开一个会话" } };
			const switched = (await options.engine.switchModel?.(conversationId, modelId)) ?? false;
			if (!switched) {
				return { ok: false, error: { code: "model.switch_failed", message: `切换模型失败：${modelId}` } };
			}
			options.state.model = modelId;
			// 不再推提示：输入区的模型选择器已经在显示当前模型（提示条太占地方）
			options.onChanged();
			return { ok: true };
		},
	};
}
