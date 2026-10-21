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
	refresh: (conversationId: string | null) => Promise<void>;
	/** 切换当前会话的模型 */
	switchTo: (conversationId: string | null, modelId: string) => Promise<Result>;
	/** 刷新可选档位与当前值（模型不支持推理时两者都为空/null） */
	refreshThinking: (conversationId: string | null) => Promise<void>;
	/** 热重载模型表（ADR-0025 §4）：改完配置后不必重启 */
	reload: (conversationId: string | null) => Promise<void>;
	/** 设置思考强度；档位不被支持时返回错误（不静默吞掉） */
	setThinking: (conversationId: string | null, level: string) => Promise<Result>;
};

export function createModelController(options: {
	engine: EnginePort;
	state: { model: string | null; models: ModelOption[]; thinkingLevel: string | null; thinkingLevels: string[] };
	notice: (text: string, level: "info" | "warn" | "error") => void;
	onChanged: () => void;
}): ModelController {
	return {
		async refresh(conversationId?: string | null) {
			// 取不到就**保留旧列表**，绝不清空。
			// 原因：切会话 / 引擎刚启动的那一瞬间 listModels 会返回空或抛错，
			// 一旦清空，输入区的模型选择器与侧栏「模型」面板里的内置 provider 会一起消失
			// （用户看到的就是「刚才还有，怎么又不见了」）。
			try {
				const list = (await options.engine.listModels?.(conversationId ?? undefined)) ?? [];
				if (list.length > 0 || options.state.models.length === 0) {
					options.state.models = list.map((model) => ({ id: model.id, label: model.label }));
				}
			} catch {
				// 保留旧值：下次刷新成功自然会更新
			}
		},

		async reload(conversationId: string | null) {
			await options.engine.reloadModels?.().catch(() => undefined);
			await this.refresh(conversationId);
			await this.refreshThinking(conversationId ?? null);
			options.onChanged();
		},

		async refreshThinking(conversationId: string | null) {
			// 与模型列表同一套纪律：取不到就保留旧值，别让控件闪没
			try {
				const levels = (await options.engine.listThinkingLevels?.(conversationId ?? undefined)) ?? [];
				const current = (await options.engine.getThinkingLevel?.(conversationId ?? undefined)) ?? null;
				if (levels.length === 0 && options.state.thinkingLevels.length > 0) return;
				options.state.thinkingLevels = levels;
				options.state.thinkingLevel = current;
			} catch {
				// 保留旧值
			}
		},

		async setThinking(conversationId, level) {
			if (!conversationId) return { ok: false, error: { code: "session.none", message: "先打开一个会话" } };
			const applied = (await options.engine.setThinkingLevel?.(conversationId, level)) ?? false;
			if (!applied)
				return { ok: false, error: { code: "thinking.unsupported", message: `这个模型不支持档位：${level}` } };
			options.state.thinkingLevel = level;
			options.onChanged();
			return { ok: true };
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
