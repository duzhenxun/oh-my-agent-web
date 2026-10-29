/**
 * 模型列表与切换（ADR-0020 §P2）——从 runtime 抽出（400 行护栏）。
 *
 * 列表来自引擎的注册表（只列**已配置鉴权**的模型），切换写进会话文件（SDK 的 model_change），
 * 所以「续聊时模型不变」是它自带的性质，不需要我们额外持久化。
 *
 * 拿不到列表时保持空数组（界面退回只读芯片）—— 不编造默认值，也不阻塞主流程。
 */
import type { EngineModelInfo, EnginePort } from "../engine/port.js";
import type { ModelOption, ProtocolError } from "../protocol.js";

export type Result = { ok: true } | { ok: false; error: ProtocolError };

type ModelController = {
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
	state: {
		model: string | null;
		models: ModelOption[];
		thinkingLevel: string | null;
		thinkingLevels: string[];
		/**
		 * 「每个会话自己那份」。**快照按会话取的就是它**（`pickPerConversation`），
		 * 以前这两张表从没被写过 —— 于是永远回落到全局的 `model` / `thinkingLevel`：
		 * 在窗口 A 给会话 1 换个模型，窗口 B 看会话 2 也跟着变（用户报的 bug）。
		 */
		modelByConversation: Record<string, string | null>;
		thinkingByConversation: Record<string, string | null>;
	};
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
				/** 引擎标的「这个会话现在用哪个」（会话文件里的 model_change） */
				const currentId = list.find((model) => model.current)?.id ?? null;
				if (conversationId) {
					// 按会话落账：这才是「这个会话自己的模型」，别人换模型不该影响它
					if (currentId) options.state.modelByConversation[conversationId] = currentId;
				} else if (!options.state.model && list.length > 0) {
					// 还没有当前模型（刚建会话 / 刚切引擎）：用引擎标的默认项，别让选择器空着
					const preferred = list.find((model) => model.current) ?? list[0];
					if (preferred) options.state.model = preferred.id;
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
				// 档位也是「每个会话一份」：只写全局的话，A 会话调到「最高」会把 B 会话也顶上去
				if (conversationId) options.state.thinkingByConversation[conversationId] = current;
				options.state.thinkingLevel = current;
			} catch {
				// 保留旧值
			}
		},

		async setThinking(conversationId, level) {
			if (!conversationId) return { ok: false, error: { code: "session.none", message: "先打开一个会话" } };
			const applied = (await options.engine.setThinkingLevel?.(conversationId, level)) ?? false;
			if (!applied) {
				const reason = options.engine.lastError?.();
				return {
					ok: false,
					error: {
						code: "thinking.unsupported",
						message: reason ? `切换思考档位失败：${reason}` : `这个模型不支持档位：${level}`,
					},
				};
			}
			options.state.thinkingByConversation[conversationId] = level;
			options.state.thinkingLevel = level;
			options.onChanged();
			return { ok: true };
		},

		async switchTo(conversationId, modelId) {
			if (!conversationId) {
				/**
				 * 还没开会话（空状态）：这里选的是「新会话用哪个模型」的**起点**，不是某个会话的模型。
				 * 以前这里直接报「先打开一个会话」—— 于是切到 dsh / opencode / claude 之后
				 * 模型下拉看着能用、点一下就报错（用户报的「模型有问题」）。
				 * 真的会生效：新建会话时 `wanted = defaultModelFor(workspace) ?? state.model`。
				 */
				if (options.state.models.length > 0 && !options.state.models.some((model) => model.id === modelId)) {
					return { ok: false, error: { code: "model.unknown", message: `不在当前引擎的模型列表里：${modelId}` } };
				}
				options.state.model = modelId;
				options.onChanged();
				return { ok: true };
			}
			const switched = (await options.engine.switchModel?.(conversationId, modelId)) ?? false;
			if (!switched) {
				const reason = options.engine.lastError?.();
				return {
					ok: false,
					error: {
						code: "model.switch_failed",
						message: reason ? `切换模型失败：${reason}` : `切换模型失败：${modelId}`,
					},
				};
			}
			/**
			 * 「这个会话用的模型」的事实源是引擎（它把 model_change 写进会话文件），
			 * 这里只是把界面要显示的那份**按会话**记下来 ——
			 * 只写全局的话，另一个窗口看别的会话也会跟着变成这个模型。
			 */
			options.state.modelByConversation[conversationId] = modelId;
			// 全局那份是「新会话的起点」，跟着最近一次选择走（与 projectPrefs.defaultModels 互补）
			options.state.model = modelId;
			// 不再推提示：输入区的模型选择器已经在显示当前模型（提示条太占地方）
			options.onChanged();
			return { ok: true };
		},
	};
}

/**
 * 「重读模型表」的独立入口（切引擎与 provider 热重载共用）：
 * prewarm（有的引擎要先把模型表挂到会话上）→ reloadModels → listModels。
 * 取不到就**保留旧表**：模型下拉宁可短暂显示旧的，也不能整块消失。
 */
export function createModelRefresher(options: {
	engine: EnginePort;
	state: { models: ModelOption[]; model?: string | null; versions?: { engine: string | null } };
}): () => Promise<void> {
	return async () => {
		try {
			await options.engine.prewarm?.();
			await options.engine.reloadModels?.();
		} catch {
			return; // 引擎没起起来（比如 codex 没装）：保留旧表，别把切换流程打断
		}
		// 懒启动的引擎（codex / dsh / opencode）要等 prewarm 之后才知道自己的版本号：
		// 顺手补上抬头那一行（否则启动就是 `opencode v—`，非得手动切一次引擎才显示）
		const version = options.engine.version?.() ?? null;
		if (version && options.state.versions) options.state.versions.engine = version;
		let list: EngineModelInfo[] = [];
		try {
			list = (await options.engine.listModels?.()) ?? [];
		} catch {
			return;
		}
		if (list.length > 0) {
			options.state.models = list.map((model) => ({ id: model.id, label: model.label }));
			// 还没有当前模型（刚切引擎 / 还没开会话）：用引擎给的默认项，别让选择器空着
			if (!options.state.model) {
				const preferred = list.find((model) => model.current) ?? list[0];
				if (preferred) options.state.model = preferred.id;
			}
		}
	};
}
