/**
 * 一次性文本补全的**编排层**（引擎无关）：给「标题 / 模板 / 想想」三处共用。
 *
 * 为什么需要这一层：这三处只想要一段文本，不需要工具、历史、审批、回合。
 * 走 agent 回合既慢又会把请求写进对话记录（「想想」以前甚至要发哨兵再删），
 * 而且模型在临时会话里仍会尝试发工具调用 —— 截图里那串 `<||DSML|| calls>`
 * 就是 DeepSeek 的工具调用语法漏进了正文。直连请求不带工具定义，从源头没有这个问题。
 *
 * 两条路，按顺序试：
 *   ① **引擎直连**（`engine.completeText`）：pi 有。复用该会话的模型与鉴权，
 *      订阅登录 / token 刷新都由引擎自己管，最贴合「当前会话用什么模型」。
 *   ② **工作台直连**（providerStore 里的 key / access token）：任何引擎都能用。
 *      只有订阅登录、没有 key 的 provider 在这里可能失败 —— 会如实报出来，不偷偷换模型。
 */
import type { OneShotResult } from "../providers/one-shot.js";

/** 一个「能直连的模型」：够发一次请求的全部信息（凭证由调用方取好） */
export type OneShotTarget = {
	provider: string;
	model: string;
	api: string;
	baseUrl: string;
	credential: string;
	/** 订阅登录的账号 id（openai-codex 必需） */
	accountId?: string | null;
	headers?: Record<string, string>;
};

export type TextCompletion = { ok: true; text: string } | { ok: false; code: string; message: string };

export type CompleteTextInput = {
	/** 这次生成属于哪条会话（决定「用哪个模型」；模板弹窗里可能还没有会话） */
	conversationId?: string | null;
	prompt: string;
	system: string;
};

export type OneShotDeps = {
	/** 引擎直连；没有这个能力的引擎返回 null（不抛错） */
	engineComplete?: (conversationId: string, prompt: string, system: string) => Promise<string | null>;
	/** 该会话当前在用的模型（`provider/model`），没有就 null */
	sessionModelOf: (conversationId: string) => string | null;
	/** 工作台里**有凭证**的模型（按优先级排好），用于兜底 */
	availableTargets: () => Promise<OneShotTarget[]>;
	/** 真发一次 HTTP 请求 */
	send: (target: OneShotTarget, input: { prompt: string; system: string }) => Promise<OneShotResult>;
};

/** `provider/model` → 拆成两段（provider 里可能带 `/`，所以按**最后一个**斜杠拆太脆，改成首个匹配） */
export function splitModelId(modelId: string): { provider: string; model: string } | null {
	const slash = modelId.indexOf("/");
	if (slash <= 0 || slash === modelId.length - 1) return null;
	return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

/**
 * 把「会话模型」对上工作台里的候选：先按 `provider/model` 精确匹配，
 * 再退回「模型 id 相同」的任意 provider（不同引擎对 provider 叫法不一样）。
 */
export function preferSessionTarget(targets: OneShotTarget[], sessionModel: string | null): OneShotTarget[] {
	if (!sessionModel) return targets;
	const split = splitModelId(sessionModel);
	const exact = split
		? targets.filter((target) => target.provider === split.provider && target.model === split.model)
		: [];
	if (exact.length > 0) return [...exact, ...targets.filter((target) => !exact.includes(target))];
	const wanted = split?.model ?? sessionModel;
	const byModel = targets.filter((target) => target.model === wanted);
	return byModel.length > 0 ? [...byModel, ...targets.filter((target) => !byModel.includes(target))] : targets;
}

export function createTextCompleter(deps: OneShotDeps): (input: CompleteTextInput) => Promise<TextCompletion> {
	return async (input) => {
		const conversationId = input.conversationId ?? null;
		const failures: string[] = [];

		// ① 引擎直连：只有会话真的开着、且引擎有这能力时才走
		if (conversationId && deps.engineComplete) {
			try {
				const text = await deps.engineComplete(conversationId, input.prompt, input.system);
				if (text !== null && text.trim() !== "") return { ok: true, text };
			} catch (error) {
				failures.push(`引擎直连：${error instanceof Error ? error.message : String(error)}`);
			}
		}

		// ② 工作台直连：会话模型优先，其余有凭证的模型兜底
		let targets: OneShotTarget[] = [];
		try {
			targets = await deps.availableTargets();
		} catch (error) {
			failures.push(`读模型配置：${error instanceof Error ? error.message : String(error)}`);
		}
		const ordered = preferSessionTarget(targets, conversationId ? deps.sessionModelOf(conversationId) : null);
		if (ordered.length === 0) {
			return {
				ok: false,
				code: "oneshot.no_model",
				message:
					failures.length > 0
						? `没有可用模型：${failures.join("；")}`
						: "没有可用模型：先在「模型」里配一个带 API key 的模型",
			};
		}

		for (const target of rotationOrder(ordered)) {
			const result = await deps.send(target, { prompt: input.prompt, system: input.system });
			if (result.ok) return { ok: true, text: result.text };
			failures.push(`${target.provider}/${target.model}：${result.message}`);
		}
		return { ok: false, code: "oneshot.failed", message: `生成失败：${failures.join("；")}` };
	};
}

/**
 * 重试顺序：**先跨 provider 各试一个，再回头试同一家的第二个**。
 *
 * 起因是一个真实故障：会话模型在 `openai-codex` 下，工作台直连那家的端点是 404，
 * 于是三个模型全落在同一家、连报三次 404，看起来像「怎么切都切不过去」。
 * 换到别的 provider 往往一次就通 —— 所以按「provider 轮转」取样，最多试 3 个。
 */
export function rotationOrder(targets: OneShotTarget[], max = 3): OneShotTarget[] {
	const picked: OneShotTarget[] = [];
	const usedProviders = new Set<string>();
	// 第一轮：每个 provider 取一个（保持原有优先级）
	for (const target of targets) {
		if (picked.length >= max) break;
		if (usedProviders.has(target.provider)) continue;
		usedProviders.add(target.provider);
		picked.push(target);
	}
	// 第二轮：补满（同一个 provider 的第二个模型）
	for (const target of targets) {
		if (picked.length >= max) break;
		if (picked.includes(target)) continue;
		picked.push(target);
	}
	return picked;
}
