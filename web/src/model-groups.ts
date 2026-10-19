/**
 * 模型分组（P6）：下拉里按**厂家**分组 + 顶层筛选框（纯函数，便于单测）。
 *
 * 分组键取 `id` 的 provider 段（`provider/modelId`）——同一厂家不同模型常常标签相同
 * （例如 NEXITA 和 NEXITA-ANTHROPIC 都有 "DeepSeek V4.1 Flash"），所以列表必须带上厂家，
 * 否则用户根本分不清点的是哪一个。
 */
import type { ModelOption } from "./types.ts";

export type ModelGroup = { provider: string; models: ModelOption[] };

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
