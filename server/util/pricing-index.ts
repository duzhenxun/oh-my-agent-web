/**
 * 分时价格的**运行时索引**（`provider/model` → 时段表 + 全天价）。
 *
 * 为什么要有这一层：算钱的时候手里只有「模型名 + token 数 + 时刻」，
 * 而那可能是每一轮里的每一次模型调用 —— 不能每次都去读 JSON。
 * 所以在两处刷新一次、之后只查内存：
 *   - 服务启动时（`server/index.ts`）；
 *   - 模型表热重载时（`engine/model-registry-reload.ts` 本来就要读这两份配置）。
 *
 * 查不到 = 这个模型没配时段 → 调用方继续用引擎给的 cost（既有行为完全不变）。
 * 配置写坏了（手改 JSON 写坏）→ 那一项当作没配，不抛、不把整张表带崩。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	costOfUsage,
	normalizePrice,
	priceAt,
	validateSchedule,
	type CostSchedule,
	type PricePerMillion,
	type UsageTokens,
} from "./pricing.js";

export const MODELS_FILE = "models.json";
export const MODELS_STORE_FILE = "models-store.json";

type PriceEntry = { base: PricePerMillion | null; schedule: CostSchedule | null };

/** 一份配置里的模型（只认我们关心的两个字段，别的一概不管） */
type PricingModel = { id: string; cost?: unknown; costSchedule?: unknown };
type PricingProvider = { provider: string; models: PricingModel[] };

let byRef = new Map<string, PriceEntry>();
let byModel = new Map<string, PriceEntry | null>();

function toEntry(model: PricingModel): PriceEntry | null {
	const parsed = validateSchedule(model.costSchedule, "分时价格");
	const schedule = parsed.ok ? parsed.value : null;
	const base = normalizePrice(model.cost);
	if (!schedule && !base) return null;
	return { base, schedule };
}

/** 纯函数：把若干 provider 的模型摊成索引（同 provider/model 后者覆盖前者，与「自定义优先」一致） */
function buildPriceIndex(sources: PricingProvider[]): {
	byRef: Map<string, PriceEntry>;
	byModel: Map<string, PriceEntry | null>;
} {
	const refs = new Map<string, PriceEntry>();
	for (const source of sources) {
		for (const model of source.models) {
			if (typeof model?.id !== "string" || model.id === "") continue;
			const entry = toEntry(model);
			const ref = `${source.provider}/${model.id}`;
			if (entry) refs.set(ref, entry);
			else refs.delete(ref);
		}
	}
	// 裸模型名（只有一份时才认）：有的引擎只报 `modelId` 不带 provider
	const bare = new Map<string, PriceEntry | null>();
	for (const [ref, entry] of refs) {
		const id = ref.slice(ref.indexOf("/") + 1);
		if (!bare.has(id)) bare.set(id, entry);
		else if (bare.get(id) !== entry) bare.set(id, null); // 重名 → 有歧义，不猜
	}
	return { byRef: refs, byModel: bare };
}

/** 用一批配置替换索引（热重载 / 启动都用它） */
export function setPriceIndex(sources: PricingProvider[]): void {
	const built = buildPriceIndex(sources);
	byRef = built.byRef;
	byModel = built.byModel;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {}; // 不存在 / 坏文件都按空表处理（可重建，见 ADR-0005）
	}
}

/** 从 pi 的两份配置重建索引（自定义那份额外优先，和 provider 列表的顺序一致） */
export async function refreshPriceIndex(agentDir: string): Promise<void> {
	const [catalog, store] = await Promise.all([
		readJson(join(agentDir, MODELS_FILE)),
		readJson(join(agentDir, MODELS_STORE_FILE)),
	]);
	const sources: PricingProvider[] = [];
	const collect = (raw: unknown) => {
		if (typeof raw !== "object" || raw === null) return;
		for (const [provider, entry] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof entry !== "object" || entry === null) continue;
			const models = (entry as { models?: unknown }).models;
			if (!Array.isArray(models)) continue;
			sources.push({ provider, models: models as PricingModel[] });
		}
	};
	collect((catalog as { providers?: unknown }).providers);
	collect(store);
	setPriceIndex(sources);
}

/** `provider/model` → 价格项；裸模型名也能查（无歧义时） */
function priceEntryFor(modelRef: string | undefined | null): PriceEntry | null {
	if (typeof modelRef !== "string" || modelRef === "") return null;
	const exact = byRef.get(modelRef);
	if (exact) return exact;
	// 引擎报的 provider 前缀和我们配置的不一致时，退回裸模型名（有重名就查不到，宁可不改账）
	const slash = modelRef.lastIndexOf("/");
	return byModel.get(slash >= 0 ? modelRef.slice(slash + 1) : modelRef) ?? null;
}

/**
 * 这一刻这次调用该记多少钱（美元）。
 *
 * 返回 `undefined` = 这个模型没配分时价格 → 调用方保留引擎算出来的 cost。
 * 配了时段之后**不再用**引擎的 cost：厂商的分时价引擎根本不知道，混着算只会更错。
 */
export function scheduledCost(
	modelRef: string | undefined | null,
	usage: UsageTokens,
	atMs: number,
): number | undefined {
	const entry = priceEntryFor(modelRef);
	if (!entry || !entry.schedule) return undefined;
	const price = priceAt(entry.schedule, entry.base, atMs);
	if (!price) return undefined;
	return costOfUsage(usage, price);
}
