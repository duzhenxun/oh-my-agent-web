/**
 * 首启向导（三步）：选引擎 → 填 provider key → 建第一条会话。
 *
 * 为什么放客户端而不是服务端设置：这三步只描述「这台机器第一次打开时怎么上手」，
 * 完成标记留在本机 localStorage（App.tsx 读写），服务端一个字段都不用加。
 *
 * 引擎清单来自快照（`snapshot.engines`，快照是唯一事实源）；「装没装」快照里没有，
 * 走既有的 `/api/engines`（和 EnginePicker 同一条路）。查不到就按已装处理，不挡人往下走。
 */
import { useEffect, useState } from "react";
import { startNewSession, useAppSelector } from "../store.ts";
import { setEngine, setModel, upsertProvider } from "../ws.ts";
import type { EngineOption } from "../types.ts";
import { useT } from "../use-language.ts";
import { useBrandName } from "../use-brand-name.ts";

type PresetId = "deepseek" | "openai" | "anthropic" | "custom";

type Preset = {
	id: PresetId;
	label: string;
	labelEn: string;
	provider: string;
	baseUrl: string;
	/** 只能是 ProviderForm 下拉里已有的协议值：现编一个 pi 不认，配好也用不了 */
	api: string;
	model: string;
};

/**
 * 三个常用服务商 + 自定义。
 *
 * 模型 id 也照仓库里已有的写法：DeepSeek / OpenAI 是这两家最常见的默认模型；
 * Anthropic 用仓库里 claude 会话与测试一直在用的 `claude-opus-4-6`，不另造一个。
 */
const PRESETS: Preset[] = [
	{
		id: "deepseek",
		label: "DeepSeek",
		labelEn: "DeepSeek",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		api: "openai-completions",
		model: "deepseek-chat",
	},
	{
		id: "openai",
		label: "OpenAI",
		labelEn: "OpenAI",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		api: "openai-completions",
		model: "gpt-4o-mini",
	},
	{
		id: "anthropic",
		label: "Anthropic",
		labelEn: "Anthropic",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		api: "anthropic-messages",
		model: "claude-opus-4-6",
	},
	{
		id: "custom",
		label: "自定义",
		labelEn: "Custom",
		provider: "",
		baseUrl: "",
		// 自定义也按 OpenAI 兼容开局（和 ProviderForm 的默认一致），之后可在设置里改
		api: "openai-completions",
		model: "",
	},
];

/** 与服务端 `providers/validate.ts` 同一形状：先在本地拦住，别让错误只落在向导背后的提示条上 */
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
/** 服务端允许的最短 key（`MIN_API_KEY_CHARS`）：太短的提交上去只会得到一条错误 */
const MIN_API_KEY_CHARS = 8;

type EngineInstallState = { installed: boolean; installable: boolean };
type EngineState = "builtin" | "checking" | "installed" | "missing" | "manual";

const NO_ENGINES: EngineOption[] = [];

/**
 * 每个引擎卡片右上角那一个字：内置（pi）/ 检测中 / 已安装 / 未安装 / 需要安装。
 *
 * 「需要安装」= 没装且没有一键安装包（dsh 那种），和「未安装但点一下就能装」分开说，
 * 免得用户点进去才发现没有安装按钮。
 */
function engineStateOf(engine: EngineOption, status: Record<string, EngineInstallState> | null): EngineState {
	if (engine.name === "pi") return "builtin";
	if (status === null) return "checking";
	const entry = status[engine.name];
	if (!entry || entry.installed) return "installed";
	return entry.installable ? "missing" : "manual";
}

export function FirstRunWizard({ onDone }: { onDone: () => void }) {
	const t = useT();
	/** 品牌名跟顶栏同一份（用户可在设置里改名，向导标题不该写死） */
	const brand = useBrandName();
	const snapshot = useAppSelector((state) => state.snapshot);
	const engines = snapshot?.engines ?? NO_ENGINES;

	const [step, setStep] = useState<1 | 2 | 3>(1);
	/** 默认选 pi：绝大多数人第一次打开就用它，不选也能直接点下一步 */
	const [engineName, setEngineName] = useState<string>("pi");
	const [presetId, setPresetId] = useState<PresetId>("deepseek");
	const [provider, setProvider] = useState("deepseek");
	const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
	const [apiKey, setApiKey] = useState("");
	const [modelId, setModelId] = useState("deepseek-chat");
	/** 工作区默认填当前会话那个 root；清空后按「默认工作区」处理 */
	const [workspace, setWorkspace] = useState(snapshot?.files?.root ?? "");
	/** 底部那行红字：只放「现在不能提交」的原因 */
	const [error, setError] = useState<string | null>(null);
	/** null = 还在查；查失败给空表（全部按已装，不挡人） */
	const [engineStatus, setEngineStatus] = useState<Record<string, EngineInstallState> | null>(null);

	useEffect(() => {
		let cancelled = false;
		void fetch("/api/engines")
			.then(async (response) =>
				response.ok
					? ((await response.json()) as {
							engines: { name: string; installed: boolean; installable?: boolean }[];
						})
					: null,
			)
			.then((body) => {
				if (cancelled) return;
				const next: Record<string, EngineInstallState> = {};
				for (const engine of body?.engines ?? []) {
					next[engine.name] = { installed: engine.installed, installable: engine.installable !== false };
				}
				setEngineStatus(next);
			})
			.catch(() => {
				if (!cancelled) setEngineStatus({});
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Esc = 跳过：向导不是必须走完的流程，关闭和「跳过」应当是同一件事
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onDone();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onDone]);

	const stepLabels = [
		t("选择引擎", "Choose engine"),
		t("配置模型", "Configure model"),
		t("开始会话", "Start a session"),
	];

	const stateLabel = (state: EngineState) =>
		state === "builtin"
			? t("内置", "Built-in")
			: state === "checking"
				? t("检测中…", "Checking…")
				: state === "installed"
					? t("已安装", "Installed")
					: state === "missing"
						? t("未安装", "Not installed")
						: t("需要安装", "Needs install");

	const goToProvider = () => {
		setError(null);
		// 照约发一次：服务端对「已经是这个引擎」直接返回，不会白重连一遍
		setEngine(engineName);
		setStep(2);
	};

	const selectPreset = (id: PresetId) => {
		const preset = PRESETS.find((item) => item.id === id);
		if (!preset) return;
		setPresetId(id);
		setProvider(preset.provider);
		setBaseUrl(preset.baseUrl);
		setModelId(preset.model);
		// 换一家就清掉 key：把 DeepSeek 的 key 带进 OpenAI 输入框，提交上去只会得到 401
		setApiKey("");
		setError(null);
	};

	const submitProvider = () => {
		const id = provider.trim();
		const url = baseUrl.trim();
		const model = modelId.trim();
		const key = apiKey.trim();
		if (key === "") {
			setError(t("先填 API Key：空 key 提交上去也用不了。", "Add an API key first — an empty one will not work."));
			return;
		}
		if (key.length < MIN_API_KEY_CHARS) {
			setError(
				t(`API Key 至少 ${MIN_API_KEY_CHARS} 位。`, `The API key needs at least ${MIN_API_KEY_CHARS} characters.`),
			);
			return;
		}
		if (!PROVIDER_ID_RE.test(id)) {
			setError(
				t(
					"provider id 只能用小写字母、数字和 -，2–31 位（会作为 provider/model 的前缀）。",
					"The provider id must be 2–31 chars of lowercase letters, digits or “-” (it prefixes provider/model).",
				),
			);
			return;
		}
		if (url === "" || !/^https?:\/\//i.test(url)) {
			setError(t("baseUrl 要以 http:// 或 https:// 开头。", "baseUrl must start with http:// or https://."));
			return;
		}
		if (model === "") {
			setError(t("填一个模型 id，例如 deepseek-chat。", "Enter a model id, e.g. deepseek-chat."));
			return;
		}
		const preset = PRESETS.find((item) => item.id === presetId);
		upsertProvider({
			provider: id,
			baseUrl: url,
			api: preset?.api ?? "openai-completions",
			apiKey: key,
			models: [{ id: model }],
		});
		// 写完 provider 立刻把当前模型指过去（服务端按 `provider/model` 选）；
		// 带上当前会话 id，跟输入区模型下拉的调用点一致 —— 不带会落到服务端猜的那个会话上。
		setModel(`${id}/${model}`, snapshot?.active.conversationId ?? null);
		setError(null);
		setStep(3);
	};

	const finish = () => {
		const path = workspace.trim();
		// 空串 = 交给服务端用默认工作区（`startNewSession` 的 null 语义）
		startNewSession(path === "" ? null : path);
		onDone();
	};

	const preset = PRESETS.find((item) => item.id === presetId);
	const apiKind = preset?.api ?? "openai-completions";

	return (
		<div className="first-run-backdrop" role="dialog" aria-modal="true" aria-labelledby="first-run-title">
			<div className="first-run-card">
				<div className="first-run-head">
					<div>
						<h2 className="first-run-title" id="first-run-title">
							{t(`欢迎使用 ${brand.name}`, `Welcome to ${brand.name}`)}
						</h2>
						<p className="first-run-subtitle">
							{t(
								"三步就能开始：选引擎、配一个模型、建第一条会话。",
								"Three steps to get going: pick an engine, configure a model, start your first session.",
							)}
						</p>
					</div>
					<button type="button" className="btn btn-tiny first-run-skip" onClick={onDone}>
						{t("跳过", "Skip")}
					</button>
				</div>

				<ol className="first-run-steps">
					{stepLabels.map((label, index) => {
						const number = (index + 1) as 1 | 2 | 3;
						return (
							<li
								key={label}
								className={`first-run-step${step === number ? " first-run-step-on" : ""}${
									step > number ? " first-run-step-done" : ""
								}`}
							>
								<span className="first-run-step-index" aria-hidden="true">
									{number}
								</span>
								<span>{label}</span>
							</li>
						);
					})}
				</ol>

				<div className="first-run-body">
					{step === 1 ? (
						<>
							<div className="first-run-hint">
								{t(
									"引擎决定谁来干活。没装的也能选：切过去之后界面会给你安装入口。",
									"Pick the agent that does the work. You can choose one that is not installed — the app will offer to install it.",
								)}
							</div>
							<div className="first-run-engines">
								{engines.length === 0 ? (
									<div className="first-run-hint">
										{t("引擎清单还没到，稍等一下。", "The engine list has not arrived yet — one moment.")}
									</div>
								) : (
									engines.map((engine) => {
										const selected = engineName === engine.name;
										const state = engineStateOf(engine, engineStatus);
										const stateClass =
											state === "installed" || state === "builtin"
												? " first-run-engine-state-on"
												: state === "missing" || state === "manual"
													? " first-run-engine-state-warn"
													: "";
										return (
											<button
												type="button"
												key={engine.name}
												className={`first-run-engine${selected ? " first-run-engine-on" : ""}`}
												aria-pressed={selected}
												onClick={() => {
													setEngineName(engine.name);
													setError(null);
												}}
											>
												<span className="first-run-engine-top">
													<span className="first-run-engine-name">{t(engine.label)}</span>
													<span className={`first-run-engine-state${stateClass}`}>{stateLabel(state)}</span>
												</span>
												{engine.description ? (
													<span className="first-run-engine-desc">{t(engine.description)}</span>
												) : null}
												{/* 只对没装的写提示：已装的引擎再解释一遍「切过去会怎样」就是噪音 */}
												{state === "missing" ? (
													<span className="first-run-engine-hint">
														{t(
															"还没装：可以继续，切过去后按提示一键安装。",
															"Not installed: continue, then install it with one click when prompted.",
														)}
													</span>
												) : state === "manual" ? (
													<span className="first-run-engine-hint">
														{t(
															"还没装且没有一键安装包：要先自己把它装好。",
															"Not installed and no one-click package: install it yourself first.",
														)}
													</span>
												) : null}
											</button>
										);
									})
								)}
							</div>
						</>
					) : step === 2 ? (
						<>
							<div className="first-run-presets" role="group" aria-label={t("服务商", "Provider")}>
								{PRESETS.map((item) => (
									<button
										type="button"
										key={item.id}
										className={`first-run-preset${presetId === item.id ? " first-run-preset-on" : ""}`}
										aria-pressed={presetId === item.id}
										onClick={() => selectPreset(item.id)}
									>
										{t(item.label, item.labelEn)}
									</button>
								))}
							</div>
							{engineName === "pi" ? null : (
								<div className="first-run-hint">
									{t(
										"当前选的不是 pi：它的模型由引擎自己管理。这里填的 provider 会写进 pi 的配置，之后切回 pi 时直接可用。",
										"The selected engine is not pi: it manages its own models. This provider is written to pi's config and will be ready when you switch back.",
									)}
								</div>
							)}
							<label className="first-run-field">
								<span>{t("provider（作为 provider/model 前缀）", "provider (prefix of provider/model)")}</span>
								<input
									value={provider}
									readOnly={presetId !== "custom"}
									onChange={(event) => setProvider(event.target.value)}
									placeholder="my-endpoint"
									autoComplete="off"
								/>
							</label>
							<label className="first-run-field">
								<span>base url</span>
								<input
									value={baseUrl}
									onChange={(event) => setBaseUrl(event.target.value)}
									placeholder="https://api.example.com/v1"
									autoComplete="off"
								/>
							</label>
							<label className="first-run-field">
								<span>API Key</span>
								<input
									type="password"
									value={apiKey}
									onChange={(event) => setApiKey(event.target.value)}
									placeholder="sk-…"
									autoComplete="off"
								/>
							</label>
							<label className="first-run-field">
								<span>{t("模型 id", "Model id")}</span>
								<input
									value={modelId}
									onChange={(event) => setModelId(event.target.value)}
									placeholder={t("例如 deepseek-chat", "e.g. deepseek-chat")}
									autoComplete="off"
								/>
							</label>
							<div className="first-run-hint">
								{t(
									`接口形态：${apiKind}（自定义也按这个开局，之后可在设置里改）。key 只写进本机配置，不会回显。`,
									`API shape: ${apiKind} (custom starts with this too; change it later in Settings). The key is stored locally and never shown again.`,
								)}
							</div>
						</>
					) : (
						<>
							<label className="first-run-field">
								<span>{t("工作区路径", "Workspace path")}</span>
								<input
									value={workspace}
									onChange={(event) => setWorkspace(event.target.value)}
									placeholder={t("留空用默认工作区", "Leave empty for the default workspace")}
									autoComplete="off"
								/>
							</label>
							<div className="first-run-hint">
								{t(
									"留空用默认工作区。填了的话，这条会话就在那个目录里跑。",
									"Leave it empty to use the default workspace. Otherwise the session runs in the directory you enter.",
								)}
							</div>
						</>
					)}
				</div>

				{error ? (
					<div className="first-run-error" role="alert">
						{error}
					</div>
				) : null}

				<div className="first-run-actions">
					<button
						type="button"
						className="btn"
						disabled={step === 1}
						onClick={() => {
							setError(null);
							setStep((current) => (current > 1 ? ((current - 1) as 1 | 2 | 3) : current));
						}}
					>
						{t("上一步", "Back")}
					</button>
					<span className="first-run-actions-grow" />
					{step === 3 ? (
						<button type="button" className="btn first-run-primary" onClick={finish}>
							{t("开始", "Start")}
						</button>
					) : (
						<button
							type="button"
							className="btn first-run-primary"
							onClick={step === 1 ? goToProvider : submitProvider}
						>
							{t("下一步", "Next")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
