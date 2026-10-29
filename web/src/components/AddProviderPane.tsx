/**
 * 「添加服务商」面板：三种来源放一页，各自一组。
 *
 * 为什么要有它：左侧列表**默认只显示能用的**（有 key 或订阅已登录），
 * 剩下的「官方目录里那 41 家、9 个订阅渠道、自己填一个」不该混在列表里当噪音 ——
 * 它们只在"要加的时候"才有意义，所以收进这个面板按来源分三组：
 *
 *   1. 订阅服务（OAuth 登录，额度走订阅）；
 *   2. 官方内置（pi 自己的目录里、还没配 key 的）；
 *   3. 自定义（手填 baseUrl / 模型）。
 */
import { useT } from "../use-language.ts";
import type { ProviderView } from "../types.ts";
import type { SubscriptionEntry } from "./SubscriptionDetail.tsx";

export type AddProviderTab = "subscription" | "builtin" | "custom";

export function AddProviderPane({
	tab,
	onTab,
	subscriptions,
	catalog,
	onPickSubscription,
	onPickBuiltin,
	onPickCustom,
}: {
	tab: AddProviderTab;
	onTab: (tab: AddProviderTab) => void;
	/** 全部订阅渠道（已登录的排在前面） */
	subscriptions: SubscriptionEntry[];
	/** pi 目录里还没配置的官方内置 provider */
	catalog: ProviderView[];
	onPickSubscription: (id: string) => void;
	onPickBuiltin: (provider: string) => void;
	onPickCustom: () => void;
}) {
	const t = useT();
	const tabs: { id: AddProviderTab; label: string; count: number }[] = [
		{
			id: "subscription",
			label: t("订阅服务", "Subscriptions"),
			count: subscriptions.length,
		},
		{ id: "builtin", label: t("官方内置", "Built-in"), count: catalog.length },
		{ id: "custom", label: t("自己输入", "Custom"), count: 0 },
	];
	return (
		<div className="prov-add-pane">
			<div className="side-panel-head">
				<strong>{t("添加服务商", "Add a provider")}</strong>
				<span className="side-panel-count">
					{t("按来源选一种：订阅登录 / pi 目录里的 / 自己填", "Pick a source: subscription, pi's catalog, or your own")}
				</span>
			</div>
			<div className="prov-tabs">
				{tabs.map((item) => (
					<button
						type="button"
						key={item.id}
						className={`prov-tab${tab === item.id ? " prov-tab-on" : ""}`}
						onClick={() => onTab(item.id)}
					>
						{item.label}
						{item.count > 0 ? ` ${item.count}` : ""}
					</button>
				))}
			</div>

			{tab === "subscription" ? (
				<div className="prov-add-list">
					{subscriptions.length === 0 ? (
						<div className="side-panel-hint">
							{t("引擎没报上来可订阅的渠道。", "The engine reported no subscription providers.")}
						</div>
					) : null}
					{subscriptions.map((entry) => (
						<button type="button" key={entry.id} className="prov-add-row" onClick={() => onPickSubscription(entry.id)}>
							<span className="prov-add-name">{entry.name}</span>
							<span className={`prov-sub-state${entry.connected ? " prov-sub-state-on" : ""}`}>
								{entry.connected
									? t("已登录 · 点开管理", "Signed in · open to manage")
									: entry.subscription
										? t("订阅额度 · 点开登录", "Subscription quota · click to sign in")
										: t("OAuth · 点开登录", "OAuth · click to sign in")}
							</span>
						</button>
					))}
				</div>
			) : null}

			{tab === "builtin" ? (
				<div className="prov-add-list">
					<div className="side-panel-hint">
						{t(
							"pi 自己的目录里还没配 key 的。点一下就能填一把 key，模型表由目录提供。",
							"Providers in pi's own catalog that have no key yet — click one to paste a key; the model list comes from the catalog.",
						)}
					</div>
					{catalog.length === 0 ? (
						<div className="side-panel-hint">
							{t("目录里的都已经配好了。", "Everything in the catalog is configured.")}
						</div>
					) : null}
					{catalog.map((provider) => (
						<button
							type="button"
							key={provider.provider}
							className="prov-add-row"
							onClick={() => onPickBuiltin(provider.provider)}
						>
							<span className="prov-add-name">{provider.label ?? provider.provider}</span>
							<span className="prov-item-sub">
								{provider.needsExtraConfig
									? t("需额外配置", "Needs setup")
									: provider.oauthOnly
										? t("只能订阅登录", "Subscription only")
										: t(`${provider.modelCount ?? 0} 个模型`, `${provider.modelCount ?? 0} models`)}
							</span>
						</button>
					))}
				</div>
			) : null}

			{tab === "custom" ? (
				<div className="prov-add-list">
					<div className="side-panel-hint">
						{t(
							"自己填 base url / api 形态 / 模型清单。适合自建网关、局域网里的模型服务。",
							"Fill in base url, API shape and the model list yourself — useful for your own gateway or a model server on the LAN.",
						)}
					</div>
					<button type="button" className="btn btn-tiny" onClick={onPickCustom}>
						＋ {t("新建自定义服务商", "New custom provider")}
					</button>
				</div>
			) : null}
		</div>
	);
}
