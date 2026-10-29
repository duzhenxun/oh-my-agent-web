import { useState } from "react";
import { testModel } from "../ws.ts";
import type { ProviderView } from "../types.ts";
import { removeModel, updateModel } from "../ws.ts";
import { tNow, useT } from "../use-language.ts";

type PriceKey = "input" | "output" | "cacheRead" | "cacheWrite";

/** 段内价格的字段名与标题（分时价格表表单用） */
const PRICE_KEYS: PriceKey[] = ["input", "output", "cacheRead", "cacheWrite"];
const PRICE_TITLES: Record<PriceKey, string> = {
	input: "输入",
	output: "输出",
	cacheRead: "缓存读",
	cacheWrite: "缓存写",
};

const PRICE_TITLES_EN: Record<PriceKey, string> = {
	input: "Input",
	output: "Output",
	cacheRead: "Cache read",
	cacheWrite: "Cache write",
};

/** 一段分时价格（表单里一律用字符串：留空 = 沿用全天价 / 到下一段） */
type SegmentForm = { start: string; end: string } & Record<PriceKey, string>;

type ModelSpecForm = {
	id: string;
	name: string;
	reasoning: boolean;
	imageInput: boolean;
	contextWindow: string;
	maxTokens: string;
	input: string;
	output: string;
	cacheRead: string;
	cacheWrite: string;
	/** 分时价格（ADR-0026 D 期）：空数组 = 全天一个价 */
	schedule: SegmentForm[];
};

/** 从 provider 视图里取一个模型的初始表单（规格/价格拿不到就留空 —— 显示"未提供"，不写 0） */
function initialForm(provider: ProviderView, modelId: string): ModelSpecForm {
	const model = provider.models.find((item) => item.id === modelId);
	const cost = model?.cost ?? {};
	const text = (value: unknown) => (typeof value === "number" ? String(value) : "");
	return {
		id: modelId,
		name: model?.name ?? modelId,
		reasoning: model?.reasoning === true,
		imageInput: model?.imageInput === true,
		contextWindow: text(model?.contextWindow),
		maxTokens: text(model?.maxTokens),
		input: text(cost.input),
		output: text(cost.output),
		cacheRead: text(cost.cacheRead),
		cacheWrite: text(cost.cacheWrite),
		schedule: (model?.costSchedule ?? []).map((segment) => ({
			start: segment.start,
			end: segment.end ?? "",
			input: text(segment.input),
			output: text(segment.output),
			cacheRead: text(segment.cacheRead),
			cacheWrite: text(segment.cacheWrite),
		})),
	};
}

/**
 * 本地预检（只挡明显的手误）：真正的规则在服务端 `validateSchedule`。
 *
 * 为什么前端也要查一遂：弹窗是全覆盖的，服务端拒绝时那条提示在顶栏、**根本看不见** ——
 * 用户看到的就是「填完点了保存，什么也没发生」。这里先报出来，且**不发请求**。
 */
function checkSchedule(schedule: SegmentForm[]): string | null {
	// 秒可有可无：有的浏览器 / 系统给的是 12:00:00（存的时候会裁成 HH:MM）
	const clock = /^\d{1,2}:\d{2}(?::\d{2})?$/;
	const seen = new Set<string>();
	for (const [index, segment] of schedule.entries()) {
		const start = segment.start.trim();
		const end = segment.end.trim();
		if (!clock.test(start)) return tNow(`第 ${index + 1} 段还没填开始时间`, `Segment ${index + 1} has no start time`);
		if (seen.has(start))
			return tNow(
				`${start} 这个开始时间填了两次（同一时刻只能有一段价格）`,
				`${start} is used twice (only one price per moment)`,
			);
		seen.add(start);
		if (end !== "" && end === start)
			return tNow(`第 ${index + 1} 段的开始和结束时间相同`, `Segment ${index + 1} starts and ends at the same time`);
		for (const key of PRICE_KEYS) {
			const raw = segment[key].trim();
			if (raw === "") continue;
			const value = Number(raw);
			if (!Number.isFinite(value) || value < 0)
				return tNow(
					`第 ${index + 1} 段的${PRICE_TITLES[key]}必须是非负数`,
					`Segment ${index + 1}: ${PRICE_TITLES_EN[key]} must be a non-negative number`,
				);
		}
	}
	return null;
}

/** 新加一段时给个不撞车的起始时间（已有 12:00 就提议 13:00；没有就 12:00） */
function suggestStart(schedule: SegmentForm[]): string {
	const used = new Set(schedule.map((segment) => segment.start));
	const last = schedule.at(-1)?.start ?? "11:00";
	const hour = Number(last.slice(0, 2));
	for (let step = 1; step <= 24; step += 1) {
		const value = `${String((hour + step) % 24).padStart(2, "0")}:00`;
		if (!used.has(value)) return value;
	}
	return "12:00";
}

/**
 * 逐模型编辑（ADR-0026 A 期）：ID / Name / 能力 / 规格 / 价格。
 *
 * 三个刻意的细节：
 *   - 价格留空 = 未提供（界面显示"未提供"，**不写 0**——0 会被误读成免费）；
 *   - 保存后提示"重启后生效"：pi 的模型表是进程内缓存（ADR-0025 §4 尚未做热重载）；
 *   - 校验在服务端（validateModelSpec），一次列出所有问题，前端不重复实现规则。
 *
 * 分时价格（ADR-0026 D 期）：厂商按高峰/低峰定价时，可以再给模型配「几段 → 几套价」；
 * 不配就是全天一个价（上面的输入框），配了就算账时按「调用发生那一刻」挑一段。
 */
export function ModelEditor({
	provider,
	modelId,
	onClose,
}: {
	provider: ProviderView;
	modelId: string;
	onClose: () => void;
}) {
	const t = useT();
	const [form, setForm] = useState<ModelSpecForm>(() => initialForm(provider, modelId));
	const [sent, setSent] = useState(false);
	/** 本地预检的问题（服务端拒绝时那条提示在顶栏，弹窗里看不见 —— 所以自己先报） */
	const [issue, setIssue] = useState<string | null>(null);
	const [catalog, setCatalog] = useState<string | null>(null);
	const [testBusy, setTestBusy] = useState(false);
	// 结果用布尔存成功与否：靠文案前缀判断会错（改一次文案就全变红）
	const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
	/** 「填入模型信息」进行中：按钮显示进度，填完恢复原样 */
	const [filling, setFilling] = useState(false);
	const set = <K extends keyof ModelSpecForm>(key: K, value: ModelSpecForm[K]) =>
		setForm((current) => ({ ...current, [key]: value }));

	/** 改某一段的某一个字段（其余段原样保留） */
	const setSegment = (index: number, key: keyof SegmentForm, value: string) =>
		setForm((current) => ({
			...current,
			schedule: current.schedule.map((segment, position) =>
				position === index ? { ...segment, [key]: value } : segment,
			),
		}));

	const addSegment = () =>
		setForm((current) => ({
			...current,
			schedule: [
				...current.schedule,
				{ start: suggestStart(current.schedule), end: "", input: "", output: "", cacheRead: "", cacheWrite: "" },
			],
		}));

	const removeSegment = (index: number) =>
		setForm((current) => ({
			...current,
			schedule: current.schedule.filter((_, position) => position !== index),
		}));

	/** 从 models.dev 预填（查不到就明确说"没查到"，不猜） */
	const fillFromCatalog = async () => {
		const started = Date.now();
		setFilling(true);
		setCatalog(null);
		try {
			const response = await fetch(
				`/api/providers/${encodeURIComponent(provider.provider)}/catalog?model=${encodeURIComponent(form.id)}`,
			);
			const body = (await response.json()) as {
				spec?: {
					name: string;
					contextWindow: number | null;
					maxTokens: number | null;
					reasoning: boolean;
					imageInput: boolean;
					cost: Record<string, number> | null;
				};
				error?: { message?: string };
			};
			if (!response.ok || !body.spec) {
				setCatalog(t("models.dev 里没查到，请手动填写", "Not found on models.dev — please fill it in by hand"));
				return;
			}
			const spec = body.spec;
			setForm((current) => ({
				...current,
				name: spec.name || current.name,
				reasoning: spec.reasoning,
				imageInput: spec.imageInput,
				contextWindow: spec.contextWindow === null ? "" : String(spec.contextWindow),
				maxTokens: spec.maxTokens === null ? "" : String(spec.maxTokens),
				input: spec.cost ? String(spec.cost.input ?? "") : "",
				output: spec.cost ? String(spec.cost.output ?? "") : "",
				cacheRead: spec.cost ? String(spec.cost.cacheRead ?? "") : "",
				cacheWrite: spec.cost ? String(spec.cost.cacheWrite ?? "") : "",
			}));
			setCatalog(t("已填入", "Filled in"));
		} finally {
			// 请求常常几十毫秒就回来了，直接复位会「闪一下什么都看不见」；
			// 保证进度态至少停留 400ms，用户能确认「点了、在填」。
			setTimeout(() => setFilling(false), Math.max(0, 400 - (Date.now() - started)));
		}
	};

	const runTest = async () => {
		setTestBusy(true);
		setTestResult(null);
		const result = await testModel(provider.provider, form.id);
		setTestResult({
			ok: result.ok,
			text: result.ok
				? t(
						`已连接 · ${result.latencyMs}ms · HTTP ${result.status}`,
						`Connected · ${result.latencyMs}ms · HTTP ${result.status}`,
					)
				: t(`未连接 · ${result.message}`, `Not connected · ${result.message}`),
		});
		setTestBusy(false);
	};

	const save = () => {
		// 先本地预检：有问题就就地提示、不发请求（否则用户只会看到「什么也没发生」）
		const problem = checkSchedule(form.schedule);
		setIssue(problem);
		if (problem) return;
		// 分时价格：空着的字段一律**不传**（服务端把它们当「沿用全天价 / 到下一段」），
		// 不传而不是传 0：0 会被当成「这一段免费」。
		const costSchedule = form.schedule.map((segment) => ({
			start: segment.start,
			...(segment.end.trim() !== "" ? { end: segment.end } : {}),
			...PRICE_KEYS.reduce<Record<string, string>>((fields, key) => {
				if (segment[key].trim() !== "") fields[key] = segment[key];
				return fields;
			}, {}),
		}));
		updateModel(provider.provider, {
			id: form.id,
			name: form.name,
			reasoning: form.reasoning,
			imageInput: form.imageInput,
			contextWindow: form.contextWindow,
			maxTokens: form.maxTokens,
			cost: { input: form.input, output: form.output, cacheRead: form.cacheRead, cacheWrite: form.cacheWrite },
			costSchedule,
		});
		setSent(true);
	};

	return (
		<div className="side-panel model-editor">
			<div className="side-panel-head">
				<strong>{t("模型", "Model")}</strong>
				<span className="side-panel-count mono">{provider.provider}</span>
				<span className="topbar-spacer" />
				{/* 保存放顶部：面板内容一多（好几个时段）就要滚，底部按钮容易「找不到」 */}
				<button
					type="button"
					className="btn btn-tiny btn-primary"
					onClick={save}
					title={t("保存模型信息（含分时价格）", "Save the model (including time-of-day prices)")}
				>
					{t("保存", "Save")}
				</button>
				{testResult ? (
					<span className={`prov-test-pill${testResult.ok ? " prov-test-ok" : " prov-test-fail"}`}>
						{testResult.text}
					</span>
				) : null}
				<button
					type="button"
					// 样式保持原样（不搞成蓝底）：出结果后只是恢复可点，随时能再测
					className="btn btn-tiny"
					onClick={() => void runTest()}
					disabled={testBusy}
					title={t("发送一次最小 chat 请求（max_tokens=1）", "Send one minimal chat request (max_tokens=1)")}
				>
					{testBusy ? t("测试中…", "Testing…") : t("测试", "Test")}
				</button>
				<button
					type="button"
					className="btn btn-tiny btn-danger"
					onClick={() => {
						// 只移出模型表，不动 api key：误删了重新导入即可
						// 内置 provider 会因此落成自定义条目（覆盖 pi 的目录）
						const extra =
							provider.source === "builtin"
								? t(
										"\n（这是 pi 内置 provider，移除后会写一份自定义条目来覆盖它的模型表）",
										"\n(pi built-in provider: removing writes a custom entry that overrides its model list)",
									)
								: "";
						if (
							!window.confirm(
								t(
									`从「${provider.provider}」移除模型 ${form.id}？${extra}`,
									`Remove model ${form.id} from “${provider.provider}”?${extra}`,
								),
							)
						)
							return;
						removeModel(provider.provider, form.id);
						onClose();
					}}
				>
					{t("移除", "Remove")}
				</button>
				<button type="button" className="btn btn-tiny" onClick={onClose}>
					{t("关闭", "Close")}
				</button>
			</div>

			<div className="side-field-row">
				<label className="side-field">
					<span>{t("ID（必填）", "ID (required)")}</span>
					<input
						value={form.id}
						readOnly
						title={t("ID 是主键，改名等于新建一个模型", "The ID is the key — renaming it creates a new model")}
					/>
				</label>
				<label className="side-field">
					<span>Name</span>
					<input
						value={form.name}
						onChange={(event) => set("name", event.target.value)}
						placeholder="DeepSeek V4.1 Flash"
					/>
				</label>
			</div>

			<div className="side-field">
				<span>{t("能力", "Capabilities")}</span>
				<label className="side-check">
					<input
						type="checkbox"
						checked={form.reasoning}
						onChange={(event) => set("reasoning", event.target.checked)}
					/>
					{t("推理 / 思考", "Reasoning / thinking")}
				</label>
				<label className="side-check">
					<input
						type="checkbox"
						checked={form.imageInput}
						onChange={(event) => set("imageInput", event.target.checked)}
					/>
					{t("图片输入", "Image input")}
				</label>
			</div>

			<div className="side-field">
				<span>{t("模型规格", "Model limits")}</span>
				<div className="side-field-row">
					<label className="side-field">
						<span>{t("上下文窗口（tokens）", "Context window (tokens)")}</span>
						<input
							inputMode="numeric"
							value={form.contextWindow}
							onChange={(event) => set("contextWindow", event.target.value)}
							placeholder="1000000"
						/>
					</label>
					<label className="side-field">
						<span>{t("最大输出 tokens", "Max output tokens")}</span>
						<input
							inputMode="numeric"
							value={form.maxTokens}
							onChange={(event) => set("maxTokens", event.target.value)}
							placeholder="384000"
						/>
					</label>
				</div>
			</div>

			<div className="side-field">
				<span>
					{t(
						"每百万 tokens 价格（全天价；留空 = 未提供）",
						"Price per million tokens (flat all-day rate; empty = not provided)",
					)}
				</span>
				<div className="side-field-row">
					<label className="side-field">
						<span>{t("输入", "Input")}</span>
						<input
							inputMode="decimal"
							value={form.input}
							onChange={(event) => set("input", event.target.value)}
							placeholder={t("未提供", "not provided")}
						/>
					</label>
					<label className="side-field">
						<span>{t("输出", "Output")}</span>
						<input
							inputMode="decimal"
							value={form.output}
							onChange={(event) => set("output", event.target.value)}
							placeholder={t("未提供")}
						/>
					</label>
					<label className="side-field">
						<span>{t("缓存读", "Cache read")}</span>
						<input
							inputMode="decimal"
							value={form.cacheRead}
							onChange={(event) => set("cacheRead", event.target.value)}
							placeholder={t("未提供")}
						/>
					</label>
					<label className="side-field">
						<span>{t("缓存写", "Cache write")}</span>
						<input
							inputMode="decimal"
							value={form.cacheWrite}
							onChange={(event) => set("cacheWrite", event.target.value)}
							placeholder={t("未提供")}
						/>
					</label>
				</div>
			</div>

			<div className="side-field">
				<span>{t("分时价格（可选，按本机时区）", "Time-of-day prices (optional, local timezone)")}</span>
				{form.schedule.length === 0 ? (
					<div className="side-panel-hint">
						{t("不填时段 = 全天都用上面的价格", "No segments = the flat price above applies all day")}
					</div>
				) : null}
				{form.schedule.map((segment, index) => (
					<div className="price-seg" key={index}>
						<div className="side-field-row">
							<label className="side-field">
								<span>{t("开始", "Start")}</span>
								<input
									type="time"
									value={segment.start}
									onChange={(event) => setSegment(index, "start", event.target.value)}
								/>
							</label>
							<label className="side-field">
								<span>{t("结束（空 = 到下一段）", "End (empty = until the next segment)")}</span>
								<input
									type="time"
									value={segment.end}
									onChange={(event) => setSegment(index, "end", event.target.value)}
								/>
							</label>
							<button
								type="button"
								className="btn btn-tiny btn-danger"
								onClick={() => removeSegment(index)}
								title={t("删掉这一段（删完就回到全天一个价）", "Delete this segment (back to one all-day price)")}
							>
								{t("删", "Del")}
							</button>
						</div>
						<div className="side-field-row">
							{PRICE_KEYS.map((key) => (
								<label className="side-field" key={key}>
									<span>{PRICE_TITLES[key]}</span>
									<input
										inputMode="decimal"
										value={segment[key]}
										onChange={(event) => setSegment(index, key, event.target.value)}
										placeholder={t("同全天价", "same as flat")}
									/>
								</label>
							))}
						</div>
					</div>
				))}
				<button
					type="button"
					className="btn btn-tiny"
					onClick={addSegment}
					title={t("加一段高峰 / 低峰价格", "Add a peak / off-peak segment")}
				>
					+ {t("添加时段", "Add segment")}
				</button>
				{form.schedule.length > 0 ? (
					<div className="side-panel-hint">
						{t(
							"每段从开始时间生效，直到下一段开始；没填结束的最后一段会跨零点接到最早那段。段内价格留空 = 沿用上面的全天价；想精确控制某几个小时就填结束时间。",
							"Each segment applies from its start time until the next one starts; a last segment without an end wraps past midnight into the earliest one. Leaving a segment's price empty reuses the flat rate; fill the end time to target specific hours.",
						)}
					</div>
				) : null}
			</div>

			<div className="import-foot">
				<button
					type="button"
					className="btn btn-tiny"
					title={t(
						"从 models.dev 查这个模型的公开规格（只作建议值，会覆盖当前已填的规格）",
						"Look up public specs on models.dev (suggestions only; overwrites the values above)",
					)}
					onClick={() => void fillFromCatalog()}
					disabled={filling}
				>
					{filling ? t("填充中…", "Filling…") : t("填入模型信息", "Fill in model specs")}
				</button>
			</div>
			{catalog ? (
				<div className={catalog.startsWith(t("已填入", "Filled in")) ? "side-ok" : "side-panel-hint side-error"}>
					{catalog}
				</div>
			) : null}
			{sent ? (
				<div className="side-ok">
					{t(
						"已提交（服务端校验通过才会写入；失败原因会显示在弹窗顶部）",
						"Submitted (written only after server validation; failures show at the top)",
					)}
				</div>
			) : null}
			{provider.source === "builtin" ? (
				<div className="side-panel-hint">
					{t(
						"当前是 pi 内置 provider：保存会直接写回",
						"This is a pi built-in provider: saving writes straight back to",
					)}{" "}
					<span className="mono">~/.pi/agent/models.json</span>
				</div>
			) : null}
			{issue ? (
				<div className="side-error side-panel-hint">
					{t("分时价格：", "Time-of-day prices: ")}
					{issue}
					{t("（尚未提交）", " (not submitted yet)")}
				</div>
			) : null}
		</div>
	);
}
