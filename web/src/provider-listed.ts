/**
 * 「这个 provider 要不要在「模型」面板左栏列出来」—— 前端唯一判定点。
 *
 * 为什么需要单独一条规则（2026-11-03 用户报的 opencode）：
 *
 * 凭证有两种来源，界面以前只认第一种 ——
 *   1. **落盘在这份配置里的**：`auth.json` 的 api key / 订阅登录 → `credential`；
 *   2. **引擎自己解析的**：环境变量、服务商自己的登录（opencode 就是这种）。
 *
 * `opencode` 属于第二种：`auth.json` 里没有它、`credential` 是 `none`，但 pi 运行时报了
 * 它 81 个 `opencode/*` 模型 —— 输入区的模型下拉里一直能选、能用。面板左栏只按 `credential`
 * 滤，于是同一个 provider「选得到却管不着」，看着像被这个面板弄丢了。
 *
 * 所以判定加一条：**引擎当前报上来这个 provider 的模型，就算能用**。
 * 为什么不用 `provider.modelCount`（引擎目录里给了多少模型）：目录里有模型 ≠ 现在能用 ——
 * `openai-codex` 在 models-store 里配着 7 个模型、目录里也有，但没登录时引擎一个都不报，
 * 那种就该老实待在「＋ 添加服务商 → 官方内置」里，而不是混进「能用的」。
 *
 * 纯函数、不碰 React：规则单独可测（`tests/unit/provider-listed.test.ts`）。
 */
import { modelProviderOf } from "./engine-model-groups.ts";

/** 判定只用到这两个字段（`ProviderView` 的子集，测试里不用造整个 view） */
export type ProviderListCandidate = {
	provider: string;
	credential?: "apiKey" | "oauth" | "none";
};

/** 引擎报上来的模型（`provider/model`）→ 它报了的 provider 集合（裸 slug 不算） */
export function engineReadyProviderIds(modelIds: string[]): Set<string> {
	const providers = new Set<string>();
	for (const modelId of modelIds) {
		const provider = modelProviderOf(modelId);
		if (provider !== null) providers.add(provider);
	}
	return providers;
}

/**
 * 左栏列不列：有 api key、订阅已登录，或者引擎已经报上来它的模型。
 * 反过来说「只有目录里的模型、凭证也没有、引擎也不报」的那些几十家不列 —— 它们是
 * 「要加的时候才需要」的，统一进「＋ 添加服务商」，免得把真正在用的淹掉。
 */
export function isProviderListed(
	view: ProviderListCandidate,
	options: { engineReady?: ReadonlySet<string> } = {},
): boolean {
	if (view.credential === "apiKey" || view.credential === "oauth") return true;
	return options.engineReady?.has(view.provider) ?? false;
}
