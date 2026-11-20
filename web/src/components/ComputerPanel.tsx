import { useEffect, useState } from "react";
import { useT } from "../use-language.ts";
import {
	KEY_DELAY_RANGE,
	POINTER_SPEED_RANGE,
	fetchComputerApps,
	fetchComputerSettings,
	fetchComputerStatus,
	saveComputerSettings,
	setComputerSkill,
	type ComputerSettings,
	type ComputerStatus,
	type InstalledAppOption,
} from "../computer.ts";

/**
 * 电脑控制面板：总开关（启用 Skill）、helper 状态与权限、以及 helper 的几项设置。
 *
 * 设置直接写入 helper 自己的配置文件（见 server/computer/settings.ts），这里不另存副本。
 */
export function ComputerPanel() {
	const t = useT();
	const [status, setStatus] = useState<ComputerStatus | null>(null);
	const [settings, setSettings] = useState<ComputerSettings | null>(null);
	const [appsDraft, setAppsDraft] = useState("");
	/** 「解除保护」输入框的应用联想 */
	const [appQuery, setAppQuery] = useState("");
	const [appOptions, setAppOptions] = useState<InstalledAppOption[]>([]);
	const [appMenuOpen, setAppMenuOpen] = useState(false);
	const [appActive, setAppActive] = useState(0);
	const [speedDraft, setSpeedDraft] = useState("");
	const [delayDraft, setDelayDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = async () => {
		setError(null);
		try {
			const [nextStatus, nextSettings] = await Promise.all([fetchComputerStatus(), fetchComputerSettings()]);
			setStatus(nextStatus);
			setSettings(nextSettings);
			setAppsDraft(nextSettings.unprotectedApps.join("\n"));
			setSpeedDraft(String(nextSettings.pointerSpeed));
			setDelayDraft(String(nextSettings.typingKeyDelayMs));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	useEffect(() => {
		void load();
	}, []);

	/** 执行一次写操作：忙的时候禁用按钮，失败就把错误显示出来 */
	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	/**
	 * 应用联想：输入「微信」也能找到 com.tencent.xinWeChat。
	 * 防抖 + AbortController：快速输入时只认最后一次请求的结果。
	 */
	useEffect(() => {
		if (!appMenuOpen) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			fetchComputerApps(appQuery, controller.signal)
				.then((result) => {
					if (controller.signal.aborted) return;
					setAppOptions(result.apps);
					setAppActive(0);
				})
				.catch(() => {
					if (!controller.signal.aborted) setAppOptions([]);
				});
		}, 180);
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [appQuery, appMenuOpen]);

	/** 把选中的 bundle id 加进名单（去重，保留用户已有的顺序） */
	const addApp = (bundleId: string) => {
		const lines = appsDraft
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		if (!lines.includes(bundleId)) setAppsDraft([...lines, bundleId].join("\n"));
		setAppQuery("");
		setAppMenuOpen(false);
	};

	const patch = (change: Partial<ComputerSettings>) =>
		run(async () => {
			setSettings(await saveComputerSettings(change));
		});

	const toggleSkill = () =>
		run(async () => {
			setStatus(await setComputerSkill(!(status?.skill.enabled ?? false)));
		});

	const commitSpeed = () => {
		const value = Number(speedDraft);
		if (!Number.isFinite(value) || value < POINTER_SPEED_RANGE.min || value > POINTER_SPEED_RANGE.max) {
			setError(
				t(
					`指针速度必须在 ${POINTER_SPEED_RANGE.min}–${POINTER_SPEED_RANGE.max} 之间`,
					`Pointer speed must be between ${POINTER_SPEED_RANGE.min} and ${POINTER_SPEED_RANGE.max}`,
				),
			);
			return;
		}
		void patch({ pointerSpeed: value });
	};

	const commitDelay = () => {
		const value = Number(delayDraft);
		if (!Number.isInteger(value) || value < KEY_DELAY_RANGE.min || value > KEY_DELAY_RANGE.max) {
			setError(
				t(
					`逐键间隔必须是 ${KEY_DELAY_RANGE.min}–${KEY_DELAY_RANGE.max} 之间的整数`,
					`Key delay must be a whole number between ${KEY_DELAY_RANGE.min} and ${KEY_DELAY_RANGE.max}`,
				),
			);
			return;
		}
		void patch({ typingKeyDelayMs: value });
	};

	const commitApps = () => {
		const ids = appsDraft
			.split(/[\n,]/)
			.map((s) => s.trim())
			.filter(Boolean);
		void patch({ unprotectedApps: ids });
	};

	const enabled = status?.skill.enabled ?? false;
	const permissionsOk = status?.permissions?.accessibility === true && status?.permissions?.screenRecording === true;

	return (
		<div className="computer-panel">
			<header className="computer-head">
				<h2>{t("电脑控制", "Computer control")}</h2>
				<button type="button" className="computer-btn" onClick={() => void load()} disabled={busy}>
					{t("刷新", "Refresh")}
				</button>
			</header>
			<p className="computer-hint">
				{t(
					"让 agent 在你的 Mac 上操作真实应用：读取界面、点击、输入、按快捷键。需要先安装 Agent Computer helper 并授权。",
					"Lets the agent operate real apps on your Mac: read the UI, click, type, press keys. Needs the Agent Computer helper installed and granted permissions.",
				)}
			</p>

			{error ? (
				<div className="computer-error" role="alert">
					{error}
				</div>
			) : null}

			{status && !status.supported ? (
				<div className="computer-error" role="alert">
					{t("电脑控制目前只支持 macOS。", "Computer control currently supports macOS only.")}
				</div>
			) : null}

			<section className="computer-section" aria-label={t("总开关", "Master switch")}>
				<label className="computer-row">
					<span className="computer-row-label">
						<strong>{t("启用电脑控制", "Enable computer control")}</strong>
						<span className="computer-hint">
							{t(
								"开启后会在 ~/.agents/skills/agent-computer 写入技能，所有能用 bash 的引擎都可以调用。关闭则把它改名为禁用。",
								"Writes the agent-computer skill to ~/.agents/skills. Any engine with bash can use it. Turning it off renames the skill to disabled.",
							)}
						</span>
					</span>
					<input
						type="checkbox"
						checked={enabled}
						disabled={busy || !status || !status.supported}
						onChange={() => void toggleSkill()}
					/>
				</label>
			</section>

			{status && !status.helper.installed && status.install ? (
				<section className="computer-section" aria-label={t("安装 helper", "Install the helper")}>
					<h3>{t("还差一个本机 helper", "One local helper left")}</h3>
					<p className="computer-hint">
						{t(
							"操作桌面应用需要一个独立的 macOS 小工具。它不在 npm 包里（要单独分发），装好之后回到这一页就能看到「运行中」。",
							"This needs a small macOS helper. It ships separately from the npm package; once installed, come back and this page shows Running.",
						)}
					</p>
					<ol className="computer-install-steps">
						{status.install.steps.map((step) => (
							<li key={step}>{step}</li>
						))}
					</ol>
					<div className="computer-install-actions">
						<a className="computer-btn" href={status.install.downloadUrl} target="_blank" rel="noreferrer">
							{t("下载 Agent Computer.app", "Download Agent Computer.app")}
						</a>
						<button type="button" className="computer-btn" onClick={() => void load()}>
							{t("装好了，重新检测", "Installed — check again")}
						</button>
					</div>
					<p className="computer-hint">
						{t(
							"已经装到别的位置？启动工作台时设置 AGENT_COMPUTER_APP=/路径/Agent Computer.app 即可。",
							"Installed somewhere else? Start the workbench with AGENT_COMPUTER_APP=/path/to/Agent Computer.app",
						)}
					</p>
				</section>
			) : null}

			<section className="computer-section" aria-label={t("helper 状态", "Helper status")}>
				<h3>{t("helper 状态", "Helper status")}</h3>
				<ul className="computer-status">
					<li>
						<span>{t("安装", "Installed")}</span>
						<span className={status?.helper.installed ? "computer-ok" : "computer-bad"}>
							{status?.helper.installed
								? status.helper.path
								: t(
										"未安装（先下载 Agent Computer.app）",
										"Not installed (download Agent Computer.app first)",
									)}
						</span>
					</li>
					<li>
						<span>{t("运行", "Running")}</span>
						<span className={status?.running ? "computer-ok" : "computer-bad"}>
							{status?.running
								? `${t("已连接", "Connected")}${status.helperVersion ? ` · ${status.helperVersion}` : ""}`
								: (status?.error ?? t("未连接", "Not connected"))}
						</span>
					</li>
					<li>
						<span>{t("辅助功能权限", "Accessibility")}</span>
						<span className={status?.permissions?.accessibility ? "computer-ok" : "computer-bad"}>
							{status?.permissions?.accessibility ? t("已授予", "Granted") : t("未授予", "Not granted")}
						</span>
					</li>
					<li>
						<span>{t("屏幕录制权限", "Screen recording")}</span>
						<span className={status?.permissions?.screenRecording ? "computer-ok" : "computer-bad"}>
							{status?.permissions?.screenRecording ? t("已授予", "Granted") : t("未授予", "Not granted")}
						</span>
					</li>
				</ul>
				{status && status.running && !permissionsOk ? (
					<p className="computer-hint">
						{t(
							"在「系统设置 → 隐私与安全性」里给 Agent Computer 开启辅助功能与屏幕录制，然后重启 helper。",
							"Allow Agent Computer under System Settings → Privacy & Security for Accessibility and Screen Recording, then restart the helper.",
						)}
					</p>
				) : null}
			</section>

			{settings ? (
				<section className="computer-section" aria-label={t("设置", "Settings")}>
					<h3>{t("设置", "Settings")}</h3>

					{/* 三个「屏幕上显示什么」的开关集中在一组，方便一眼看全 */}
					<div className="computer-block">
						<span className="computer-row-label">
							<strong>{t("屏幕上显示什么", "What shows on screen")}</strong>
						</span>
						<p className="computer-hint">
							{t(
								"AI 操作时可以显示三种提示，都可以单独关掉：右下角的小浮窗、屏幕边缘的水印、跟随光标的蓝色指针。",
								"Three optional indicators while the AI works: the preview window, an edge watermark, and a pointer ring following the cursor.",
							)}
						</p>
					</div>

					<label className="computer-row">
						<span className="computer-row-label">{t("实时预览浮窗（能看到它在操作什么）", "Live preview window")}</span>
						<input
							type="checkbox"
							checked={settings.previewEnabled}
							disabled={busy}
							onChange={() => void patch({ previewEnabled: !settings.previewEnabled })}
						/>
					</label>

					<label className="computer-row">
						<span className="computer-row-label">{t("AI 操作水印（屏幕边缘 + 顶部提示）", "AI activity watermark")}</span>
						<input
							type="checkbox"
							checked={settings.watermarkEnabled}
							disabled={busy}
							onChange={() => void patch({ watermarkEnabled: !settings.watermarkEnabled })}
						/>
					</label>

					<label className="computer-row">
						<span className="computer-row-label">{t("agent 的指针动画（跟随光标的蓝圈）", "Agent pointer ring")}</span>
						<input
							type="checkbox"
							checked={settings.pointerEnabled}
							disabled={busy}
							onChange={() => void patch({ pointerEnabled: !settings.pointerEnabled })}
						/>
					</label>

					<label className="computer-row">
						<span className="computer-row-label">
							{t("需要前台的步骤可以短暂借用前台", "Briefly borrow the foreground when needed")}
						</span>
						<input
							type="checkbox"
							checked={settings.borrowFront}
							disabled={busy}
							onChange={() => void patch({ borrowFront: !settings.borrowFront })}
						/>
					</label>

					<label className="computer-row">
						<span className="computer-row-label">
							<strong>{t("允许在你空闲时激活目标应用", "Allow activating the target app while you are idle")}</strong>
							<span className="computer-hint">
								{t(
									"默认关。开启后 agent 可能把窗口切到最前面。",
									"Off by default. When on, the agent may bring the window to the front.",
								)}
							</span>
						</span>
						<input
							type="checkbox"
							checked={settings.activateTarget}
							disabled={busy}
							onChange={() => void patch({ activateTarget: !settings.activateTarget })}
						/>
					</label>

					<label className="computer-row">
						<span className="computer-row-label">{t("指针速度", "Pointer speed")}</span>
						<input
							type="number"
							className="computer-num"
							min={POINTER_SPEED_RANGE.min}
							max={POINTER_SPEED_RANGE.max}
							step={0.25}
							value={speedDraft}
							disabled={busy}
							onChange={(e) => setSpeedDraft(e.target.value)}
							onBlur={commitSpeed}
							onKeyDown={(e) => e.key === "Enter" && commitSpeed()}
						/>
					</label>

					<label className="computer-row">
						<span className="computer-row-label">{t("逐键输入间隔（毫秒）", "Delay between typed keys (ms)")}</span>
						<input
							type="number"
							className="computer-num"
							min={KEY_DELAY_RANGE.min}
							max={KEY_DELAY_RANGE.max}
							step={1}
							value={delayDraft}
							disabled={busy}
							onChange={(e) => setDelayDraft(e.target.value)}
							onBlur={commitDelay}
							onKeyDown={(e) => e.key === "Enter" && commitDelay()}
						/>
					</label>

					<div className="computer-block">
						<span className="computer-row-label">
							<strong>
								{t("解除保护的应用（bundle id，一行一个）", "Unprotected apps (bundle id, one per line)")}
							</strong>
						</span>
						<p className="computer-hint">
							{t(
								"默认保护系统认证、系统设置等。这里加入的应用会被允许操作。密码管理器始终需要你在 helper 里确认，不受此处影响。",
								"System authentication and System Settings stay protected by default. Apps listed here become allowed. Password managers still need your confirmation in the helper.",
							)}
						</p>
						<div className="computer-app-search">
							<input
								type="text"
								className="computer-app-input"
								value={appQuery}
								disabled={busy}
								placeholder={t("搜索应用名，比如「微信」，点候选直接加进去", "Search an app, e.g. \"WeChat\"")}
								onChange={(e) => {
									setAppQuery(e.target.value);
									setAppMenuOpen(true);
								}}
								onFocus={() => setAppMenuOpen(true)}
								onBlur={() => setTimeout(() => setAppMenuOpen(false), 150)}
								onKeyDown={(e) => {
									if (e.key === "ArrowDown") {
										e.preventDefault();
										setAppMenuOpen(true);
										setAppActive((index) => Math.min(index + 1, appOptions.length - 1));
									} else if (e.key === "ArrowUp") {
										e.preventDefault();
										setAppActive((index) => Math.max(index - 1, 0));
									} else if (e.key === "Enter") {
										const option = appOptions[appActive];
										if (option) {
											e.preventDefault();
											addApp(option.bundleId);
										}
									} else if (e.key === "Escape") {
										setAppMenuOpen(false);
									}
								}}
							/>
							{appMenuOpen && appOptions.length > 0 ? (
								<ul className="computer-app-options" role="listbox">
									{appOptions.map((option, index) => (
										<li key={option.bundleId}>
											<button
												type="button"
												className={`computer-app-option${index === appActive ? " is-active" : ""}`}
												role="option"
												aria-selected={index === appActive}
												onMouseDown={(e) => {
													// mousedown：赶在输入框 blur 关掉菜单之前
													e.preventDefault();
													addApp(option.bundleId);
												}}
											>
												<span className="computer-app-name">{option.name}</span>
												<small>{option.bundleId}</small>
											</button>
										</li>
									))}
								</ul>
							) : null}
						</div>
						<textarea
							className="computer-apps"
							rows={4}
							value={appsDraft}
							disabled={busy}
							placeholder="com.apple.Notes"
							onChange={(e) => setAppsDraft(e.target.value)}
						/>
						<div>
							<button type="button" className="computer-btn" disabled={busy} onClick={commitApps}>
								{t("保存名单", "Save list")}
							</button>
						</div>
					</div>
				</section>
			) : null}
		</div>
	);
}
