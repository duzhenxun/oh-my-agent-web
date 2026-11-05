import { useEffect, useRef, useState } from "react";
import { useAppSelector } from "../store.ts";
import { isModelEnabled } from "../model-enabled.ts";
import { engineReadyProviderIds, isProviderListed } from "../provider-listed.ts";
import { deleteProvider, requestProviders, setProviderEnabled } from "../ws.ts";
import type { ProviderView } from "../types.ts";
import { ImportModels } from "./ImportModels.tsx";
import { ModelEditor } from "./ModelEditor.tsx";
import { ProviderForm, type ProviderFormHandle } from "./ProviderForm.tsx";
import { EngineModelsPanel } from "./EngineModelsPanel.tsx";
import { SubscriptionDetail, type SubscriptionEntry } from "./SubscriptionDetail.tsx";
import { AddProviderPane, type AddProviderTab } from "./AddProviderPane.tsx";
import { useT } from "../use-language.ts";

/**
 * 模型管理（左列表 + 右详情）。
 *
 * 左栏列**现在能用的** provider（自定义的 + pi 内置的），点哪个就把它的模型摊在下面；
 * 右栏是它的配置。以前只列自定义的，用户会以为 nexita / nexita-anthropic 之类「丢了」。
 * 「能用」的具体口径见 `../provider-listed.ts`：有 key / 订阅登录，**或者引擎已经报上来它的模型**
 * （后者是 2026-11-03 补的：`opencode` 的 key 不在 auth.json，以前连行都不显）。
 *
 * 内置 provider 由 pi 自己的目录管理（baseUrl / 模型表都是 pi 给的），
 * 它们是可以改的：写回 pi 的 models.json（不是另建覆盖条目），见 catalog-store.ts。
 */
export function ProvidersPanel() {
	const t = useT();
	const snapshot = useAppSelector((state) => state.snapshot);
	// provider 表是 pi 独有的（models-store.json / auth.json）：别的引擎自己管模型，
	// 这里不能拿 pi 的配置去冒充「当前引擎的模型」。
	const piOwned = (snapshot?.engine ?? "pi") === "pi";
	const providers: ProviderView[] = snapshot?.providers ?? [];
	/** 引擎当前可用的模型（`provider/modelId`）：用来标「已启用」 */
	/** 启用白名单（pi settings.json）：空数组 = 全开 */
	const allowlist = snapshot?.enabledModels ?? [];
	const providerEnabled = (provider: ProviderView) =>
		allowlist.length === 0 ||
		allowlist.some((pattern) => pattern === `${provider.provider}/**` || pattern.startsWith(`${provider.provider}/`));

	const [selected, setSelected] = useState<string | null>(null);
	/** 整个服务商列表的开合（所有来源共用这一个开关） */
	const [listOpen, setListOpen] = useState(true);
	/** 「添加服务商」面板（三种来源）：null = 没打开 */
	const [addTab, setAddTab] = useState<AddProviderTab | null>(null);
	/** 哪条订阅行展开了「这个订阅账号能用哪些模型」 */
	const [expandedSub, setExpandedSub] = useState<string | null>(null);
	/** 右栏显示的是「订阅服务」的哪一个（OAuth 登录），不是 provider 表单 */
	const [subscribing, setSubscribing] = useState<string | null>(null);
	/** 引擎声明的可 OAuth 登录 provider + 连上没（服务端 /api/subscriptions） */
	const [subscriptions, setSubscriptions] = useState<SubscriptionEntry[]>([]);
	/** 手动收起的那一项（再点一下同一个 provider 就收起它下面的模型列表） */
	const [collapsed, setCollapsed] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [importing, setImporting] = useState(false);
	const [editingModel, setEditingModel] = useState<string | null>(null);
	/** 顶部栏的「保存」触发 ProviderForm 内部的提交逻辑 */
	const providerFormRef = useRef<ProviderFormHandle | null>(null);
	/** 左栏宽度（可拖，存 localStorage —— 纯界面偏好，不该进快照） */
	const [listWidth, setListWidth] = useState(() => {
		const stored = Number(localStorage.getItem("agent-web:provider-list-width"));
		return Number.isFinite(stored) && stored >= 140 && stored <= 420 ? stored : 190;
	});
	useEffect(() => {
		localStorage.setItem("agent-web:provider-list-width", String(listWidth));
	}, [listWidth]);

	/** 订阅列表：登录 / 登出之后要重拉，顺手让 provider 列表也刷一遍 */
	const loadSubscriptions = () => {
		void (async () => {
			try {
				const response = await fetch("/api/subscriptions");
				if (!response.ok) return;
				const body = (await response.json()) as { providers?: SubscriptionEntry[] };
				setSubscriptions(body.providers ?? []);
			} catch {
				// 拿不到就当这个引擎不支持订阅服务：面板少一块，不影响别的
			}
		})();
	};
	useEffect(loadSubscriptions, [snapshot?.engine]);
	const subscription = subscriptions.find((entry) => entry.id === subscribing) ?? null;
	/**
	 * 列表顺序：**已连接（已订阅）的置顶**，同组内保持服务端给的顺序。
	 * 理由：订阅服务有 9 家，用户实际在用的就那一两个，每个都要往下找太痛；
	 * 用稳定排序（同组不重排），避免登入登出后整个列表跳动。
	 */
	const sortedSubscriptions = subscriptions
		.map((entry, index) => ({ entry, index }))
		.sort((left, right) => Number(right.entry.connected) - Number(left.entry.connected) || left.index - right.index)
		.map((item) => item.entry);
	/**
	 * 引擎**当前真的报了它的模型**（`provider/model` 出现在快照的模型表里）= 现在就能用。
	 * 判定在 `../provider-listed.ts`（那条路径上还有一段「为什么不只看 credential」）。
	 */
	const engineReady = engineReadyProviderIds((snapshot?.models ?? []).map((model) => model.id));
	/**
	 * 左栏**只列能用的**：有 api key、订阅已登录，或者引擎已经报上来它的模型。
	 * 最后一种以前漏了 —— `opencode` 的 key 不在 `auth.json`（引擎自己解析），于是它明明在输入区
	 * 的模型下拉里能选，面板里却根本找不到（2026-11-03 用户报的）。
	 * 没配置的（pi 目录里那几十家「无 key」）仍然不堆在列表里 —— 它们是"要加的时候才需要"的，
	 * 统一进「＋ 添加服务商」（按来源分：订阅 / 官方内置 / 自己输入）。
	 */
	const usable = (provider: ProviderView) => isProviderListed(provider, { engineReady });
	/**
	 * 已连接的订阅会在列表顶部单独列一行；同一个 provider 不再按官方内置 / 自定义
	 * 名称重复显示。未连接的订阅不参与去重，避免把普通 API key 配置误藏起来。
	 */
	const loggedInSubscriptions = sortedSubscriptions.filter((entry) => entry.connected);
	const connectedSubscriptionIds = new Set(loggedInSubscriptions.map((entry) => entry.id));
	const officialProviders = providers.filter(
		(provider) => provider.official === true && usable(provider) && !connectedSubscriptionIds.has(provider.provider),
	);
	const customProviders = providers.filter(
		(provider) => provider.official !== true && usable(provider) && !connectedSubscriptionIds.has(provider.provider),
	);
	/** 目录里还没配的（给「添加服务商 → 官方内置」用；需额外配置的也列出来，标清楚） */
	const catalogProviders = providers.filter(
		(provider) => provider.official === true && !usable(provider) && (provider.modelCount ?? 0) > 0,
	);
	/**
	 * 订阅行也能「展开看模型」：去重之后（订阅登录的 provider 不再单列一行），
	 * 它的模型就只能挂在这一行下面 —— 否则订阅登录完，模型在面板里彻底看不见。
	 */
	const providerOfSubscription = (id: string) => providers.find((provider) => provider.provider === id) ?? null;
	const dragging = useRef(false);

	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		dragging.current = true;
		const startX = event.clientX;
		const startWidth = listWidth;
		const onMove = (moveEvent: PointerEvent) => {
			if (!dragging.current) return;
			setListWidth(Math.min(420, Math.max(140, startWidth + (moveEvent.clientX - startX))));
		};
		const onUp = () => {
			dragging.current = false;
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	};

	// 没选或选中的没了 → 落到第一个（列表随快照变，不另存副本）
	const current = providers.find((provider) => provider.provider === selected) ?? providers[0] ?? null;
	const showForm = creating || current === null;
	const panelDetail = addTab === null;
	/** 单个模型是否启用：白名单空 = 全开；命中 `provider/**` 或精确 `provider/model` 即可 */
	const modelEnabled = (provider: string, modelId: string) => isModelEnabled(allowlist, provider, modelId);
	const enabledCount = (provider: ProviderView) =>
		provider.models.filter((model) => modelEnabled(provider.provider, model.id)).length;

	/** 全局计数：所有 provider 的模型里，落在白名单内的有多少 */
	const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0);
	const enabledTotal = providers.reduce((sum, provider) => sum + enabledCount(provider), 0);

	if (!piOwned) {
		// 非 pi 引擎：模型由引擎自己提供（codex 的 model/list、claude 的 session models、
		// opencode/dsh 的 configOptions）。布局与 pi 一致（左供应商 / 右详情），
		// 但这里**不写**任何 provider 配置 —— 那是 pi 独有的东西（见 EngineModelsPanel 文件头）。
		const engineOption = (snapshot?.engines ?? []).find((item) => item.name === snapshot?.engine);
		return <EngineModelsPanel snapshot={snapshot} engineOption={engineOption} />;
	}

	/**
	 * 左栏一行（官方内置与自定义两处复用同一份：名字、内置徽标、有无 key、
	 * 展开后的模型列表与点击行为完全一样，只有分组标题不同）。
	 */
	const renderProviderRow = (provider: ProviderView) => {
		const active = !creating && addTab === null && !subscription && current?.provider === provider.provider;
		// 高亮（右侧显示谁）不变；只有「模型列表是否展开」受点第二下控制
		const inlineOpen = active && collapsed !== provider.provider;
		// 左栏显示全量模型，禁用项也保留在列表里，才能直接逐个重新启用。
		const inlineModels = provider.models;
		return (
			<div key={provider.provider} className={`prov-block${active ? " prov-block-on" : ""}`}>
				<button
					type="button"
					className={`prov-item${active ? " prov-item-on" : ""}`}
					aria-expanded={inlineModels.length > 0 ? inlineOpen : undefined}
					onClick={() => {
						// 再点一下同一个：把模型列表收起来（右侧仍显示它的配置）
						if (active && collapsed !== provider.provider) {
							setCollapsed(provider.provider);
							return;
						}
						setCollapsed(null);
						setExpandedSub(null);
						setAddTab(null);
						setCreating(false);
						setImporting(false);
						setEditingModel(null);
						setSubscribing(null);
						setSelected(provider.provider);
					}}
				>
					<span className="prov-item-name">
						{inlineModels.length > 0 ? (
							<span className={`prov-caret${inlineOpen ? " prov-caret-open" : ""}`} aria-hidden="true" />
						) : (
							<span className="prov-caret prov-caret-empty" aria-hidden="true" />
						)}
						{/* 目录里有显示名就用那个（xai → xAI）：左栏窄，id 放 title 里 */}
						<span
							className="prov-item-label"
							title={provider.label ? `${provider.label}（${provider.provider}）` : provider.provider}
						>
							{provider.label ?? provider.provider}
						</span>
					</span>
					{/* 右侧只留**一个**状态：有 api key 就不用再说什么（能用是默认），
					    订阅登录 / 需额外配置 / 无 key 才需要一眼看见。
					    「内置」徽标去掉了 —— 分组标题已经说明了来源，行里再标一次是噪音。 */}
					{provider.credential === "apiKey" ? null : provider.credential === "oauth" ? (
						<span
							className={`prov-item-state${provider.oauth?.expired ? " prov-item-state-warn" : " prov-item-state-on"}`}
							title={
								provider.oauth?.expired
									? t(
											"订阅登录的凭据已过期：点开「订阅服务」重新登录",
											"Subscription credential expired — open Subscriptions and sign in again",
										)
									: t(
											`订阅已登录${provider.oauth?.accountHint ? `（账号 ${provider.oauth.accountHint}）` : ""}：不需要 API key，走订阅额度`,
											`Signed in${provider.oauth?.accountHint ? ` (${provider.oauth.accountHint})` : ""}: no API key needed, subscription quota is used`,
										)
							}
						>
							{provider.oauth?.expired ? t("订阅已过期", "Expired") : t("订阅已登录", "Signed in")}
						</span>
					) : engineReady.has(provider.provider) ? (
						/*
						 * 没有 api key、也不是订阅登录，但引擎已经报上来它的模型（opencode）。
						 * 这里**不能**说「无 key / 填一把就能用」—— 用户会去找一把根本不存在的 key。
						 * 只说事实：引擎现在给出这些模型，换模型用输入区那个下拉。
						 */
						<span
							className="prov-item-state prov-item-state-on"
							title={t(
								"引擎已经报上来它的模型（凭证由引擎自己解析，不在这份配置里）：能直接用，换模型用输入区的下拉",
								"The engine already reports its models (credentials are resolved by the engine, not stored here): ready to use — switch models from the composer",
							)}
						>
							{t("引擎已可用", "Ready")}
						</span>
					) : (
						<span
							className="prov-item-state"
							title={
								provider.needsExtraConfig
									? t(
											"除了 API key 还要端点 / 云凭证：去「配置」里补齐",
											"Needs an endpoint or cloud credentials on top of the API key — fill them in Config",
										)
									: provider.oauthOnly
										? t(
												"这个 provider 只支持订阅登录：去上面「订阅服务」里登录",
												"This provider only supports subscription sign-in — use Subscriptions above",
											)
										: t("填一把 API key 就能用", "Ready once you add an API key")
							}
						>
							{provider.needsExtraConfig
								? t("需额外配置", "Needs setup")
								: provider.oauthOnly
									? t("仅订阅登录", "Subscription only")
									: t("无 key", "No key")}
						</span>
					)}
				</button>
				<CollapsibleModels open={inlineOpen}>
					{inlineModels.length === 0 ? (
						<div className="side-panel-hint">
							{provider.models.length === 0 && provider.modelCount
								? t(
										`还没配 key 用不了：填一把就能用（引擎目录里 ${provider.modelCount} 个模型）`,
										`Not usable yet — add an API key (${provider.modelCount} models in the engine catalog)`,
									)
								: provider.models.length === 0
									? t("这个 provider 下没有模型", "No models under this provider")
									: t("这个 provider 下没有启用的模型", "No enabled models under this provider")}
						</div>
					) : null}
					{inlineModels.map((model) => {
						const enabled = modelEnabled(provider.provider, model.id);
						return (
							<div
								className={`prov-inline-row${
									inlineOpen && editingModel === model.id && current?.provider === provider.provider
										? " prov-inline-row-on"
										: ""
								}`}
								key={model.id}
							>
								<button
									type="button"
									className="prov-inline-open"
									aria-current={inlineOpen && editingModel === model.id && current?.provider === provider.provider}
									title={model.id}
									onClick={() => {
										setImporting(false);
										setEditingModel(model.id);
									}}
								>
									<span className="prov-inline-name">
										{model.name}
										{model.name === model.id ? null : <em className="prov-inline-id mono">{model.id}</em>}
									</span>
								</button>
								<button
									type="button"
									className={`prov-model-toggle${enabled ? " prov-model-toggle-on" : ""}`}
									role="switch"
									aria-checked={enabled}
									aria-label={`${enabled ? t("停用", "Disable") : t("启用", "Enable")} ${model.name}`}
									title={enabled ? t("点击停用", "Click to disable") : t("点击启用", "Click to enable")}
									onClick={() => setProviderEnabled(provider.provider, !enabled, model.id)}
								>
									<span className="prov-dot" />
								</button>
							</div>
						);
					})}
				</CollapsibleModels>
			</div>
		);
	};

	return (
		<>
			<div className="prov-global-bar">
				<span className="mono prov-global-path">~/.pi/agent/settings.json</span>
				<span className="side-panel-count">
					{t("已启用", "Enabled")} {enabledTotal}/{totalModels}
				</span>
				<span className="topbar-spacer" />
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => setProviderEnabled("*", true)}
					disabled={allowlist.length === 0}
					title={t(
						"清空 enabledModels 白名单 —— pi 的语义是「不限制」即全部可用",
						"Clear the enabledModels allowlist — for pi, no restriction means everything is available",
					)}
				>
					{t("启用全部模型", "Enable all models")}
				</button>
			</div>
			<div className="prov-shell" style={{ "--prov-list-width": `${listWidth}px` } as React.CSSProperties}>
				<aside className="prov-list">
					{/* 一整块：订阅服务 / 官方内置 / 自定义**同一个开关**（以前三块各有自己的三角，
					   看着像三个平行面板，收起还得点三次） */}
					<button
						type="button"
						className="prov-list-head prov-list-toggle"
						aria-expanded={listOpen}
						title={
							listOpen
								? t("收起服务商列表", "Collapse the provider list")
								: t("展开服务商列表", "Expand the provider list")
						}
						onClick={() => setListOpen((open) => !open)}
					>
						<span className="prov-list-toggle-label">
							<span
								className={`sidebar-title-caret${listOpen ? " sidebar-title-caret-open" : ""}`}
								aria-hidden="true"
							/>
							{t("服务商", "Providers")}
						</span>
					</button>

					<div className={`prov-list-body${listOpen ? "" : " prov-list-body-closed"}`}>
						{/* 订阅、官方内置、自定义都放在同一个列表里，不再显示分组标题或分割线。 */}
						<div className="prov-list-scroll">
							{loggedInSubscriptions.length + officialProviders.length + customProviders.length === 0 ? (
								<div className="side-panel-hint">
									{t("还没有服务商，点下面添加", "No providers yet — add one below")}
								</div>
							) : null}
							{loggedInSubscriptions.map((entry) => {
								const linked = providerOfSubscription(entry.id);
								const models = linked?.models ?? [];
								const active = !creating && addTab === null && subscribing === entry.id;
								const expanded = active && expandedSub === entry.id;
								return (
									<div className={`prov-block${active ? " prov-block-on" : ""}`} key={entry.id}>
										<button
											type="button"
											className={`prov-item${active ? " prov-item-on" : ""}`}
											aria-expanded={models.length > 0 ? expanded : undefined}
											title={
												expanded ? t("收起模型", "Collapse models") : t("选中并展开模型", "Select and expand models")
											}
											onClick={() => {
												// 和普通服务商一样：整行选中并展开；再点同一行只收起模型，保留右侧详情。
												setExpandedSub(models.length > 0 && !expanded ? entry.id : null);
												setAddTab(null);
												setCreating(false);
												setImporting(false);
												setEditingModel(null);
												setSubscribing(entry.id);
											}}
										>
											<span className="prov-item-name">
												{/* 三角只表示状态，整行都是展开 / 收起点击区。 */}
												{models.length > 0 ? (
													<span className={`prov-caret${expanded ? " prov-caret-open" : ""}`} aria-hidden="true" />
												) : (
													<span className="prov-caret prov-caret-empty" aria-hidden="true" />
												)}
												<span className="prov-item-label">{entry.name}</span>
												<span className="prov-sub-badge">{t("订阅", "Sub")}</span>
											</span>
											<span className={`prov-item-state${entry.connected ? " prov-item-state-on" : ""}`}>
												{entry.connected
													? t("已连接", "Connected")
													: entry.subscription
														? t("订阅额度 · 未连接", "Subscription quota · not connected")
														: t("OAuth · 未连接", "OAuth · not connected")}
											</span>
										</button>
										<CollapsibleModels open={expanded && models.length > 0}>
											{models.map((model) => {
												const enabled = modelEnabled(entry.id, model.id);
												return (
													<div className="prov-inline-row" key={model.id}>
														<button
															type="button"
															className={`prov-inline-open${
																editingModel === model.id && subscribing === entry.id ? " prov-inline-open-on" : ""
															}`}
															title={model.id}
															onClick={() => {
																if (linked) setSelected(linked.provider);
																setCreating(false);
																setImporting(false);
																setEditingModel(model.id);
															}}
														>
															<span className="prov-inline-name">
																{model.name}
																{model.name === model.id ? null : <em className="prov-inline-id mono">{model.id}</em>}
															</span>
														</button>
														<button
															type="button"
															className={`prov-model-toggle${enabled ? " prov-model-toggle-on" : ""}`}
															role="switch"
															aria-checked={enabled}
															aria-label={`${enabled ? t("停用", "Disable") : t("启用", "Enable")} ${model.name}`}
															title={enabled ? t("点击停用", "Click to disable") : t("点击启用", "Click to enable")}
															onClick={() => setProviderEnabled(entry.id, !enabled, model.id)}
														>
															<span className="prov-dot" />
														</button>
													</div>
												);
											})}
										</CollapsibleModels>
									</div>
								);
							})}

							{officialProviders.map(renderProviderRow)}
							{customProviders.map(renderProviderRow)}
						</div>
					</div>

					<button
						type="button"
						className="btn btn-tiny prov-add"
						onClick={() => {
							setAddTab((value) => (value === null ? "subscription" : null));
							setCreating(false);
							setImporting(false);
							setEditingModel(null);
							setSubscribing(null);
						}}
					>
						＋ {t("添加服务商", "Add a provider")}
					</button>
				</aside>

				{/* 分隔条：拖动改左栏宽度（双击复位） */}
				<div
					className="prov-resizer"
					role="separator"
					aria-orientation="vertical"
					title={t("拖动调整宽度（双击复位）", "Drag to resize (double-click to reset)")}
					onPointerDown={startResize}
					onDoubleClick={() => setListWidth(190)}
				/>

				<section className={`prov-detail${panelDetail ? " prov-detail-panel" : ""}`}>
					{addTab !== null ? (
						<AddProviderPane
							tab={addTab}
							onTab={setAddTab}
							subscriptions={sortedSubscriptions}
							catalog={catalogProviders}
							onPickSubscription={(id) => {
								setAddTab(null);
								setSubscribing(id);
							}}
							onPickBuiltin={(provider) => {
								setAddTab(null);
								setSelected(provider);
							}}
							onPickCustom={() => {
								setAddTab(null);
								setCreating(true);
							}}
						/>
					) : subscription && !editingModel && !importing ? (
						<SubscriptionDetail
							key={subscription.id}
							entry={subscription}
							onClose={() => setSubscribing(null)}
							onChanged={() => {
								loadSubscriptions();
								requestProviders();
							}}
							{...(subscription.id === "openai-codex" && subscription.connected
								? {
										onImportModels: () => {
											const linked = providerOfSubscription(subscription.id);
											if (!linked) return;
											setSelected(linked.provider);
											setImporting(true);
										},
									}
								: {})}
						/>
					) : editingModel && current ? (
						<ModelEditor
							key={`${current.provider}/${editingModel}`}
							provider={current}
							modelId={editingModel}
							onClose={() => setEditingModel(null)}
						/>
					) : importing && current ? (
						<ImportModels
							provider={current}
							onClose={() => setImporting(false)}
							onImported={() => {
								setImporting(false);
								loadSubscriptions();
								requestProviders();
							}}
						/>
					) : (
						<>
							<div className="prov-tabs">
								<strong className="prov-detail-title">
									{creating ? t("添加服务商", "Add provider") : t("配置", "Config")}
								</strong>
								<span className="topbar-spacer" />
								{current && !creating ? (
									<>
										<span className="side-panel-count">
											{enabledCount(current)}/{current.models.length} {t("启用", "enabled")}
										</span>
										<label
											className="prov-switch"
											title={t(
												"停用后这个 provider 的模型不再出现在选择器里",
												"When disabled, this provider's models no longer appear in the picker",
											)}
										>
											<input
												type="checkbox"
												checked={providerEnabled(current)}
												onChange={(event) => setProviderEnabled(current.provider, event.target.checked)}
											/>
											<span className="prov-switch-track" aria-hidden="true" />
										</label>
									</>
								) : null}
								<button
									type="button"
									className="btn btn-tiny btn-primary prov-save-button"
									onClick={() => providerFormRef.current?.save()}
								>
									{t("保存", "Save")}
								</button>
								{current && !creating ? (
									<button
										type="button"
										className="btn btn-tiny btn-danger"
										onClick={() => {
											const where =
												current.source === "builtin"
													? t(
															"（会从 ~/.pi/agent/models.json 里整条删掉）",
															" (the entry is removed from ~/.pi/agent/models.json)",
														)
													: "";
											if (
												!window.confirm(
													t(
														`删除 provider「${current.provider}」？它的 api key 也会一起删。${where}`,
														`Delete provider “${current.provider}”? Its API key is deleted too.${where}`,
													),
												)
											)
												return;
											deleteProvider(current.provider);
											setSelected(null);
										}}
									>
										{t("删除", "Delete")}
									</button>
								) : null}
							</div>

							<ProviderForm
								formRef={providerFormRef}
								key={showForm ? "new" : current?.provider}
								initial={showForm ? null : current}
								onSaved={(saved) => {
									// 存完就选中它：否则表单还停在「添加」态，看着像没保存成功
									setCreating(false);
									setSelected(saved);
								}}
							/>
						</>
					)}
				</section>
			</div>
		</>
	);
}

/**
 * 高度跟随内容的折叠动画：始终保留子节点，连续反向点击时可以从当前高度接着过渡，
 * 也避免收起瞬间卸载整排模型导致下面的服务商突然跳位。
 */
function CollapsibleModels({ open, children }: { open: boolean; children: React.ReactNode }) {
	return (
		<div
			className={`prov-models-collapse${open ? " prov-models-collapse-open" : ""}`}
			aria-hidden={!open}
			inert={!open}
		>
			<div className="prov-models-collapse-inner">
				<div className="prov-models-inline">{children}</div>
			</div>
		</div>
	);
}
