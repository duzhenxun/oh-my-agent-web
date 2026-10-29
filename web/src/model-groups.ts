/**
 * 模型分组（P6）：下拉里按**厂家**分组 + 顶层筛选框（纯函数）。
 *
 * 分组键取 `id` 的 provider 段（`provider/modelId`）——同一厂家不同模型常常标签相同
 * （例如 NEXITA 和 NEXITA-ANTHROPIC 都有 "DeepSeek V4.1 Flash"），所以列表必须带上厂家，
 * 否则用户根本分不清点的是哪一个。
 */
import { isModelIdEnabled } from "./model-enabled.ts";
import type { ModelOption } from "./types.ts";

type ModelGroup = { provider: string; models: ModelOption[] };

/** 纯函数：provider（`anthropic/claude-x` → `anthropic`；没有斜杠则归到 OTHER） */
export function providerOf(model: ModelOption): string {
	const slash = model.id.indexOf("/");
	return slash > 0 ? model.id.slice(0, slash) : "other";
}

/**
 * 纯函数：按厂家分组 + 按关键字筛选（厂家名、模型标签、完整 id 都参与匹配）。
 * 组内保持服务端给的原顺序（不排序，避免"顺序突然变了"）。
 */
export function groupModels(models: ModelOption[], filter = ""): ModelGroup[] {
	const keyword = filter.trim().toLowerCase();
	const groups: ModelGroup[] = [];
	const index = new Map<string, ModelGroup>();
	for (const model of models) {
		if (keyword !== "" && !`${model.label} ${model.id}`.toLowerCase().includes(keyword)) continue;
		const provider = providerOf(model);
		let group = index.get(provider);
		if (!group) {
			group = { provider, models: [] };
			index.set(provider, group);
			groups.push(group);
		}
		group.models.push(model);
	}
	return groups;
}

/**
 * 只留**已启用**的模型。
 *
 * 用户在「模型」面板里关掉的（provider 整体停用、或单个模型停用）不该还留在选择器里 ——
 * 点得到、选得了、用起来却没反应，等于把一个已经做的决定又摆回眼前。
 *
 * 判定复用 `model-enabled.ts`（与面板、与服务端 `enabled-models.ts` 同一套语义），
 * 不在这里另写一份 `startsWith` 判断。
 */
export function filterEnabledModels(models: ModelOption[], allowlist: string[]): ModelOption[] {
	if (allowlist.length === 0) return models; // 空白名单 = 全开（pi 的语义）
	return models.filter((model) => isModelIdEnabled(allowlist, model.id));
}
