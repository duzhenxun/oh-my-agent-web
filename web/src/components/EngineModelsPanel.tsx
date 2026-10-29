/**
 * 非 pi 引擎的「模型」面板：**和 pi 一样的左右两栏**（左 = 供应商，右 = 详情）。
 *
 * 为什么要单独一个文件：`ProvidersPanel` 已经是 pi 的 provider 编辑器（写 models-store.json /
 * auth.json 的那一整套），非 pi 引擎既没有那份配置、也不该去改它。但「左边挑一个、右边看细节」
 * 这个**布局**是共用的，所以这里只借用它的类名（`prov-shell` / `prov-list` / `prov-detail`），
 * 逻辑上完全独立：左栏把引擎报上来的模型按**供应商前缀**分组，右栏看这一组的模型 + 测速。
 *
 * 分组口径（见 `model-groups.ts`）：
 *   - claude → `anthropic/opus`、opencode / dsh → `provider/model`：天然按前缀分；
 *   - codex → 裸 slug（`deepseek-flash`）：全部落在「引擎自己」这一组里。
 *
 * 测速（`capabilities.modelProbe`）是本面板唯一会**替用户花钱**的动作：真跑一个最小回合，
 * 所以按个确认、顺序跑、可随时停。
 */
import { useEffect, useRef, useState } from "react";
import { probeModel } from "../ws.ts";
import { groupEngineModels, modelShortLabel } from "../engine-model-groups.ts";
import type { ModelOption, Snapshot } from "../types.ts";
import { useT } from "../use-language.ts";

export function EngineModelsPanel(props: {
	snapshot: Snapshot | null;
	engineOption?: { badge?: string; label?: string };
}) {
	const t = useT();
	const snapshot = props.snapshot;
	const engine = snapshot?.engine ?? "";
	const models: ModelOption[] = snapshot?.models ?? [];
	/** 当前模型是 id 字符串（`provider/model`），行上要标「当前」就得自己比 */
	const currentModelId = snapshot?.model ?? null;
	const groups = groupEngineModels(models, {
		name: engine,
		label: props.engineOption?.label ?? engine.toUpperCase(),
	});
	const canProbe = snapshot?.engineCapabilities.modelProbe === true;

	/** 右栏看的是哪一组（切引擎 / 模型表变了就回到第一组） */
	const [selected, setSelected] = useState<string | null>(null);
	const current = groups.find((group) => group.id === selected) ?? groups[0] ?? null;
	/** 左栏里展开模型的那一组（pi 的交互：点一下选中并展开，再点只收起） */
	const [expanded, setExpanded] = useState<string | null>(null);
	/** 整列服务商可以收起（与 pi 的左栏同一个开关） */
	const [listOpen, setListOpen] = useState(true);
	/** 左栏宽度（可拖，存 localStorage —— 纯界面偏好，不进快照） */
	const [listWidth, setListWidth] = useState(() => {
		const stored = Number(localStorage.getItem("agent-web:engine-model-list-width"));
		return Number.isFinite(stored) && stored >= 140 && stored <= 420 ? stored : 190;
	});
	useEffect(() => {
		localStorage.setItem("agent-web:engine-model-list-width", String(listWidth));
	}, [listWidth]);
	const resizing = useRef(false);
	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		resizing.current = true;
		const startX = event.clientX;
		const startWidth = listWidth;
		const onMove = (moveEvent: PointerEvent) => {
			if (!resizing.current) return;
			setListWidth(Math.min(420, Math.max(140, startWidth + (moveEvent.clientX - startX))));
		};
		const onUp = () => {
			resizing.current = false;
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	};

	/** 测速：modelId → 结果；一次只测一个（并发只会打出 429，测出来也不可信） */
	const [probeResults, setProbeResults] = useState<Record<string, { ok: boolean; text: string; detail: string }>>({});
	const [probingModel, setProbingModel] = useState<string | null>(null);
	const [probeBatch, setProbeBatch] = useState<{ done: number; total: number } | null>(null);
	const probeAbort = useRef<AbortController | null>(null);

	const runProbe = async (ids: string[]) => {
		if (ids.length === 0 || probingModel !== null) return;
		const controller = new AbortController();
		probeAbort.current = controller;
		setProbeResults({});
		setProbeBatch({ done: 0, total: ids.length });
		let done = 0;
		for (const id of ids) {
			if (controller.signal.aborted) break;
			setProbingModel(id);
			const body = await probeModel(id, controller.signal);
			// 优先显示「生成速度」（首字之后那段）；样本太短时退回端到端均速 —— 不拿噪声充数
			const speed = body.tps ?? body.averageTps ?? null;
			const firstToken = body.ttftMs === null || body.ttftMs === undefined ? null : formatMs(body.ttftMs);
			const full = body.ok
				? [
						t(firstToken ? `首字 ${firstToken}` : "首字 ?", firstToken ? `first ${firstToken}` : "first ?"),
						t(
							speed === null ? "速度 ?" : `${speed} tok/s${body.tps === null ? "（均速）" : ""}`,
							speed === null ? "speed ?" : `${speed} tok/s${body.tps === null ? " (avg)" : ""}`,
						),
					].join(" · ")
				: t(`失败：${body.message ?? "未知错误"}`, `Failed: ${body.message ?? "unknown error"}`);
			// 单元格窄：只放前面一截，完整原因（引擎原话可能是长 JSON）挂在 title 上
			const text = full.length > 42 ? `${full.slice(0, 40)}…` : full;
			setProbeResults((results) => ({ ...results, [id]: { ok: body.ok, text, detail: full } }));
			done += 1;
			setProbeBatch({ done, total: ids.length });
		}
		setProbingModel(null);
		setProbeBatch(null);
		probeAbort.current = null;
	};

	const engineLabel = props.engineOption?.label ?? engine;

	return (
		<div className="prov-shell engine-models" style={{ "--prov-list-width": `${listWidth}px` } as React.CSSProperties}>
			<aside className="prov-list">
				<button
					type="button"
					className="prov-list-head prov-list-toggle"
					title={
						listOpen
							? t("收起服务商列表", "Collapse the provider list")
							: t("展开服务商列表", "Expand the provider list")
					}
					onClick={() => setListOpen((open) => !open)}
				>
					<span className="prov-list-toggle-label">
						<span className={`sidebar-title-caret${listOpen ? " sidebar-title-caret-open" : ""}`} aria-hidden="true" />
						{t("供应商", "Providers")}
					</span>
				</button>
				<div className={`prov-list-body${listOpen ? "" : " prov-list-body-closed"}`}>
					<div className="prov-list-scroll">
						{groups.length === 0 ? (
							<div className="side-panel-hint">
								{t(
									"引擎还没报上来模型：先新建一个会话",
									"The engine has not reported any models yet — create a conversation first",
								)}
							</div>
						) : null}
						{groups.map((group) => {
							const active = current?.id === group.id;
							const open = expanded === group.id && group.models.length > 0;
							return (
								<div className={`prov-block${active ? " prov-block-on" : ""}`} key={group.id}>
									<button
										type="button"
										className={`prov-item${active ? " prov-item-on" : ""}`}
										aria-expanded={open}
										title={group.id}
										onClick={() => {
											// 点一下：选中 + 展开模型；再点同一行：只收起（右栏不变）
											setSelected(group.id);
											setExpanded(open ? null : group.id);
										}}
									>
										<span className="prov-item-name">
											{group.models.length > 0 ? (
												<span className={`prov-caret${open ? " prov-caret-open" : ""}`} aria-hidden="true" />
											) : (
												<span className="prov-caret prov-caret-empty" aria-hidden="true" />
											)}
											<span className="prov-item-label">{group.label}</span>
										</span>
										<span className="prov-item-state">{`${group.models.length} ${t("个模型", "models")}`}</span>
									</button>
									{open ? (
										<div className="prov-models-inline">
											{group.models.map((model) => (
												<button
													type="button"
													key={model.id}
													className="prov-inline-row"
													title={model.id}
													onClick={() => setSelected(group.id)}
												>
													<span className="prov-inline-name">{modelShortLabel(model)}</span>
													{model.id === currentModelId ? (
														<span className="prov-sub-badge">{t("当前", "current")}</span>
													) : null}
												</button>
											))}
										</div>
									) : null}
								</div>
							);
						})}
					</div>
				</div>
			</aside>

			<div
				className="prov-resizer"
				role="separator"
				aria-orientation="vertical"
				title={t("拖动调整宽度（双击复位）", "Drag to resize (double-click to reset)")}
				onPointerDown={startResize}
				onDoubleClick={() => setListWidth(190)}
			/>

			<section className="prov-detail">
				<div className="prov-tabs">
					<span className="prov-engine-badge">{props.engineOption?.badge ?? engine.toUpperCase()}</span>
					<strong className="prov-detail-title">{current?.label ?? engineLabel}</strong>
					<span className="topbar-spacer" />
					<span className="side-panel-count">
						{current ? current.models.length : 0} {t("个模型", "models")}
					</span>
					{canProbe && current && current.models.length > 0 ? (
						<>
							<button
								type="button"
								className="btn btn-tiny"
								disabled={probingModel !== null}
								title={t(
									"对每个模型各发一次真实请求（会消耗少量额度），测首字延迟与出字速度",
									"Sends one real request per model (costs a little quota) and measures time-to-first-token and tokens/s",
								)}
								onClick={() => {
									if (
										!window.confirm(
											t(
												`会对 ${current.models.length} 个模型各发一次真实请求（消耗少量额度），继续？`,
												`This sends one real request per model (${current.models.length} total) and spends a little quota. Continue?`,
											),
										)
									)
										return;
									void runProbe(current.models.map((model) => model.id));
								}}
							>
								{probeBatch
									? t(
											`测速中… ${probeBatch.done}/${probeBatch.total}`,
											`Testing… ${probeBatch.done}/${probeBatch.total}`,
										)
									: t("⏱ 批量测速", "⏱ Test speed")}
							</button>
							{probeBatch ? (
								<button
									type="button"
									className="btn btn-tiny btn-danger"
									title={t("停止测速，已测出的结果会保留", "Stop testing and keep the results already measured")}
									onClick={() => probeAbort.current?.abort()}
								>
									■ {t("停止", "Stop")}
								</button>
							) : null}
						</>
					) : null}
				</div>

				<div className="prov-detail-body">
					<p className="prov-engine-note">
						{t(
							"这些是引擎自己报上来的模型（codex 读 model/list，claude / opencode / dsh 读会话里的模型表），本工作台不改它。换模型用输入区的模型下拉；测速是让引擎真跑一个最小回合，不读它的凭证。",
							"These models come straight from the engine (codex via model/list, claude / opencode / dsh via their session model table); this workbench does not edit them. Switch models from the composer; testing runs one minimal turn inside the engine and never touches its credentials.",
						)}
					</p>
					{current === null ? (
						<div className="side-panel-hint">
							{models.length === 0
								? t(
										"引擎还没报上来任何模型：先新建一个会话（claude / opencode 要开会话才拿得到模型表），或确认引擎已装好并登录。",
										"The engine has not reported any models yet: create a conversation first (claude / opencode only expose their model table once a session exists), or check that the engine is installed and signed in.",
									)
								: t("左边挑一个供应商看模型。", "Pick a provider on the left to see its models.")}
						</div>
					) : (
						<div className="engine-model-list">
							{current.models.map((model) => {
								const result = probeResults[model.id];
								const isCurrent = model.id === currentModelId;
								return (
									<div className={`engine-model-row${isCurrent ? " engine-model-row-on" : ""}`} key={model.id}>
										<span className="engine-model-name" title={model.id}>
											{modelShortLabel(model)}
										</span>
										<span className="engine-model-id mono">{model.id}</span>
										{isCurrent ? <span className="prov-sub-badge">{t("当前", "current")}</span> : null}
										{canProbe ? (
											<span className="engine-model-probe">
												{probingModel === model.id ? (
													<span className="side-panel-count">{t("测速中…", "Testing…")}</span>
												) : result ? (
													<span
														className={`prov-latency${result.ok ? " prov-latency-ok" : " prov-latency-fail"}`}
														title={result.detail}
													>
														{result.text}
													</span>
												) : (
													<button
														type="button"
														className="btn btn-tiny"
														disabled={probingModel !== null}
														title={t(
															"发一次真实请求测这个模型（会消耗少量额度）",
															"Sends one real request to measure this model (costs a little quota)",
														)}
														onClick={() => void runProbe([model.id])}
													>
														{t("测速", "Test")}
													</button>
												)}
											</span>
										) : null}
									</div>
								);
							})}
						</div>
					)}
				</div>
			</section>
		</div>
	);
}

/** 毫秒 → 人看的短文本（`1234ms` 太长时用秒） */
function formatMs(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}
