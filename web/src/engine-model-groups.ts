/**
 * 把引擎报上来的模型按**供应商**分组（非 pi 引擎的「模型」面板左栏要的就是这个）。
 *
 * 为什么不复用 `model-groups.ts`：那份是给**下拉框**用的（`groupModels` 带关键字筛选、
 * 没有斜杠的模型统一归到 "other"）。面板左栏要的是「能当标题显示的名字」——
 * codex 的裸 slug 没有供应商，就该诚实地显示成「Codex 自己」，而不是一个叫 other 的分组。
 *
 * 口径：
 *   - claude 的 id 已统一成 `anthropic/<modelId>`（见 claude-map.ts）；
 *   - opencode / dsh 本来就是 `provider/model`（它们的 configOptions 就这么存）；
 *   - codex 是裸 slug（`deepseek-flash`）→ 整包归到一个以引擎名命名的组。
 *
 * 纯函数、不碰 React：分组规则单独可测。
 */
import type { ModelOption } from "./types.ts";

type EngineModelGroup = {
	/** 分组键（左栏行 key，也用于记住选中） */
	id: string;
	/** 给人看的名字 */
	label: string;
	models: ModelOption[];
};

/** `provider/model` 里的 provider；没有斜杠（或斜杠在首尾）就是 null */
function modelProviderOf(modelId: string): string | null {
	const cut = modelId.indexOf("/");
	if (cut <= 0 || cut === modelId.length - 1) return null;
	return modelId.slice(0, cut);
}

/** 模型在面板上的短名字：`anthropic/opus` → `opus`；裸 slug 原样 */
export function modelShortLabel(model: ModelOption): string {
	const provider = modelProviderOf(model.id);
	if (provider === null) return model.label || model.id;
	const rest = model.id.slice(provider.length + 1);
	// 引擎给的 label 常等于 id（`anthropic/opus`），去掉前缀更好认；别的 label 保持原样
	return model.label === model.id ? rest : model.label;
}

/**
 * 分组：保持「第一次出现的顺序」（引擎的排序通常有意义，比如默认模型在最前），
 * 组内也保持原顺序。
 */
export function groupEngineModels(models: ModelOption[], engine: { name: string; label: string }): EngineModelGroup[] {
	const groups = new Map<string, EngineModelGroup>();
	for (const model of models) {
		const provider = modelProviderOf(model.id);
		const id = provider ?? engine.name;
		const label = provider ?? engine.label;
		const group = groups.get(id);
		if (group) group.models.push(model);
		else groups.set(id, { id, label, models: [model] });
	}
	return [...groups.values()];
}
