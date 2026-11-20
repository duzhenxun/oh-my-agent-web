import { useEffect, useState, type FormEvent } from "react";
import {
	CRON_EVERY_MAX_HOURS,
	CRON_EVERY_MAX_MINUTES,
	CRON_EVERY_MIN,
	cronDraftReady,
	cronExpression,
	cronPreset,
	cronTime,
	previewCron,
	type CronDraft,
	type CronOptions,
	type CronPreset,
	type CronSchedule,
} from "../cron.ts";
import { useT } from "../use-language.ts";
import { generateCronPrompt } from "../ws.ts";

export function CronEditor({
	initial,
	workspaces,
	options,
	busy,
	onSave,
	onCancel,
}: {
	initial: CronDraft;
	workspaces: string[];
	/** 已注册会话与模型候选（agent 任务用） */
	options: CronOptions;
	busy: boolean;
	onSave: (draft: CronDraft) => Promise<void>;
	onCancel: () => void;
}) {
	const t = useT();
	const [draft, setDraft] = useState(() => ({
		...initial,
		expression: initial.expression.trim().split(/\s+/).join(" "),
	}));
	const [schedule, setSchedule] = useState<CronSchedule>(() => cronPreset(initial.expression));
	const [preview, setPreview] = useState<{ key: string; times: string[]; error: string } | null>(null);
	const [generating, setGenerating] = useState(false);
	const [promptError, setPromptError] = useState("");
	const previewKey = JSON.stringify([draft.expression, draft.timezone]);
	const currentPreview = preview?.key === previewKey ? preview : null;
	const canPreview = draft.expression.trim().split(/\s+/).length === 5 && Boolean(draft.timezone.trim());

	useEffect(() => {
		if (!canPreview) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			void previewCron(draft.expression, draft.timezone, controller.signal).then(
				(times) => {
					if (!controller.signal.aborted) setPreview({ key: previewKey, times, error: "" });
				},
				(error: unknown) => {
					if (!controller.signal.aborted)
						setPreview({ key: previewKey, times: [], error: error instanceof Error ? error.message : String(error) });
				},
			);
		}, 350);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [draft.expression, draft.timezone, previewKey, canPreview]);

	const set = <K extends keyof CronDraft>(key: K, value: CronDraft[K]) => setDraft((old) => ({ ...old, [key]: value }));
	/**
	 * 改计划：**先用新状态生成表达式，再写回 draft**。
	 * 不能「先 setSchedule 再读 schedule」——那样拿到的是同一帧里的旧值，
	 * 表现就是改间隔数字时表达式慢一拍（预览也跟着错一拍）。
	 */
	const applySchedule = (patch: Partial<CronSchedule>) => {
		const next: CronSchedule = { ...schedule, ...patch };
		setSchedule(next);
		if (next.preset !== "advanced") set("expression", cronExpression(next, draft.expression));
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!busy && cronDraftReady(draft, workspaces) && currentPreview && !currentPreview.error)
			void onSave({ ...draft, name: draft.name.trim(), timezone: draft.timezone.trim() });
	};
	/** 按任务标题让 AI 写一段任务描述，覆盖提示词前先确认（已有内容不能静默丢） */
	const generatePrompt = async () => {
		if (
			draft.prompt.trim() !== "" &&
			!window.confirm(t("AI 生成的内容会覆盖当前提示词，继续吗？", "AI will replace the current prompt. Continue?"))
		)
			return;
		setPromptError("");
		setGenerating(true);
		const result = await generateCronPrompt({ name: draft.name.trim() });
		setGenerating(false);
		if (!result.ok) {
			setPromptError(result.message);
			return;
		}
		set("prompt", result.text);
	};
	const weekdays = [
		t("周日", "Sunday"),
		t("周一", "Monday"),
		t("周二", "Tuesday"),
		t("周三", "Wednesday"),
		t("周四", "Thursday"),
		t("周五", "Friday"),
		t("周六", "Saturday"),
	];
	const fields = [t("分钟", "Minute"), t("小时", "Hour"), t("日", "Day"), t("月", "Month"), t("星期", "Weekday")];
	// 会话候选按工作目录过滤：任务的工作目录是哪个，就只列哪个目录下的会话
	const sessions = options.sessions.filter((session) => session.workspace === draft.workspace);
	const parts = draft.expression.split(" ");

	return (
		<form className="cron-editor" onSubmit={submit}>
			<h3>{t("任务设置", "Job settings")}</h3>
			<fieldset disabled={busy}>
				<label className="cron-field">
					{t("名称", "Name")}
					<input required value={draft.name} onChange={(event) => set("name", event.target.value)} />
				</label>
				<label className="cron-field">
					{t("工作目录", "Workspace")}
					<select
						aria-label={t("工作目录", "Workspace")}
						required
						value={draft.workspace}
						onChange={(event) => {
							// 换工作目录就把已选会话清掉：会话候选是按目录过滤的，
							// 留着旧 id 会在保存后静默去续跑另一个目录里的会话
							setDraft((old) => ({ ...old, workspace: event.target.value, sessionId: "" }));
						}}
					>
						<option value="" disabled>
							{t("选择已注册的工作目录", "Select a registered workspace")}
						</option>
						{!workspaces.includes(draft.workspace) && draft.workspace ? (
							<option value={draft.workspace} disabled>
								{draft.workspace} — {t("未注册", "Unregistered")}
							</option>
						) : null}
						{workspaces.map((workspace) => (
							<option key={workspace} value={workspace}>
								{workspace}
							</option>
						))}
					</select>
				</label>
				{workspaces.length === 0 ? (
					<p className="cron-hint">{t("请先注册一个项目工作目录。", "Register a project workspace first.")}</p>
				) : null}
				<div className="cron-field">
					<div className="cron-prompt-head">
						<span>{t("提示词", "Prompt")}</span>
						<button
							type="button"
							className="btn btn-tiny"
							disabled={generating || draft.name.trim() === ""}
							onClick={() => void generatePrompt()}
							title={t(
								"根据任务名称，写一段要做的事（会覆盖当前提示词）",
								"Write the task from its name (replaces the prompt)",
							)}
						>
							✨ {generating ? t("生成中…", "Generating…") : t("AI 生成", "Generate with AI")}
						</button>
					</div>
					<textarea
						aria-label={t("提示词", "Prompt")}
						required
						rows={5}
						value={draft.prompt}
						onChange={(event) => set("prompt", event.target.value)}
					/>
					{promptError ? (
						<p className="cron-hint cron-warn" role="alert">
							{promptError}
						</p>
					) : null}
				</div>
				<div className="cron-form-row">
					<label className="cron-field">
						{t("任务类型", "Task type")}
						<select
							aria-label={t("任务类型", "Task type")}
							value={draft.mode}
							onChange={(event) => set("mode", event.target.value === "agent" ? "agent" : "text")}
						>
							<option value="text">{t("文本任务（不读写仓库）", "Text task (no repo access)")}</option>
							<option value="agent">{t("Agent 任务（真开会话执行）", "Agent task (runs in a session)")}</option>
						</select>
					</label>
				</div>
				{draft.mode === "agent" ? (
					<>
						<p className="cron-hint">
							{t(
								"Agent 任务会在该工作区新建一个会话并真跑一遍：能读文件、跑命令。每次运行都会在侧栏留下一条会话记录。",
								"Agent tasks open a real session in this workspace: they can read files and run commands. Every run leaves a session in the sidebar.",
							)}
						</p>
						<div className="cron-form-row">
							<label className="cron-field">
								{t("会话", "Session")}
								<select
									aria-label={t("会话", "Session")}
									value={sessions.some((item) => item.id === draft.sessionId) ? draft.sessionId : ""}
									onChange={(event) => set("sessionId", event.target.value)}
								>
									<option value="">{t("每次新建会话", "New session each run")}</option>
									{sessions.map((session) => (
										<option key={session.id} value={session.id}>
											{session.title || session.id}
										</option>
									))}
								</select>
							</label>
							<label className="cron-field">
								{t("模型", "Model")}
								<select
									aria-label={t("模型", "Model")}
									value={draft.model}
									onChange={(event) => set("model", event.target.value)}
								>
									<option value="">
										{draft.sessionId
											? t("沿用该会话原来的模型", "Keep the session's model")
											: t("跟随项目默认模型", "Use the project default")}
									</option>
									{options.models.map((model) => (
										<option key={model.id} value={model.id}>
											{model.label}
										</option>
									))}
								</select>
							</label>
						</div>
						{draft.sessionId ? (
							<p className="cron-hint">
								{t(
									"会在这个会话里继续跑：提示词与结果都会进它的历史，同步删掉会话后任务会报错停下。",
									"Runs inside that session: prompt and result go into its history; deleting the session makes the job fail.",
								)}
							</p>
						) : null}
						<label className="cron-toggle">
							<input
								type="checkbox"
								checked={draft.allowWrites}
								onChange={(event) => set("allowWrites", event.target.checked)}
							/>
							{t("允许改动文件（无人值守时会自动执行写操作）", "Allow file writes (unattended writes run without confirmation)")}
						</label>
						{!draft.allowWrites ? (
							<p className="cron-hint">
								{t(
									"未开启时：需要审批的操作会被自动拒绝，agent 只能读 —— 适合「每天检查并汇报」，不适合「自动修 bug」。",
									"While off, anything needing approval is auto-denied and the agent can only read — fine for daily checks, not for auto-fixing code.",
								)}
							</p>
						) : (
							<p className="cron-hint cron-warn">
								{t(
									"已开启：运行期间 agent 的写操作不会问你，可能直接改掉工作区文件。请确认工作目录里没有不想被改的东西。",
									"Enabled: the agent's writes will not ask you, and it may modify this workspace directly. Make sure nothing here is unsafe to change.",
								)}
							</p>
						)}
					</>
				) : (
					<p className="cron-hint">
						{t(
							"文本任务只把提示词发给模型，不读文件、不跑命令 —— 便宜且可预测。要让它干活请选 Agent 任务。",
							"Text tasks only send the prompt to a model: no file access, no commands — cheap and predictable. Choose Agent task to actually do work.",
						)}
					</p>
				)}
				<div className="cron-form-row">
					<label className="cron-field">
						{t("计划", "Schedule")}
						<select
							aria-label={t("计划", "Schedule")}
							value={schedule.preset}
							onChange={(event) => applySchedule({ preset: event.target.value as CronPreset })}
						>
							<option value="minutes">{t("每隔几分钟", "Every N minutes")}</option>
							<option value="hours">{t("每隔几小时", "Every N hours")}</option>
							<option value="daily">{t("每天", "Daily")}</option>
							<option value="weekday">{t("工作日", "Weekdays")}</option>
							<option value="weekly">{t("每周", "Weekly")}</option>
							<option value="monthly">{t("每月", "Monthly")}</option>
							<option value="advanced">{t("高级（五字段）", "Advanced (five fields)")}</option>
						</select>
					</label>
					{schedule.preset === "weekly" ? (
						<label className="cron-field">
							{t("星期", "Weekday")}
							<select
								aria-label={t("星期", "Weekday")}
								value={schedule.weekday}
								onChange={(event) => applySchedule({ preset: "weekly", weekday: event.target.value })}
							>
								{weekdays.map((day, index) => (
									<option key={index} value={String(index)}>
										{day}
									</option>
								))}
							</select>
						</label>
					) : null}
					{schedule.preset === "monthly" ? (
						<label className="cron-field">
							{t("每月几号", "Day of month")}
							<select
								aria-label={t("每月几号", "Day of month")}
								value={schedule.dayOfMonth}
								onChange={(event) => applySchedule({ dayOfMonth: event.target.value })}
							>
								{Array.from({ length: 31 }, (_, index) => String(index + 1)).map((day) => (
									<option key={day} value={day}>
										{day}
									</option>
								))}
							</select>
						</label>
					) : null}
					{schedule.preset === "minutes" || schedule.preset === "hours" ? (
						<label className="cron-field">
							{schedule.preset === "minutes" ? t("每隔（分钟）", "Every (minutes)") : t("每隔（小时）", "Every (hours)")}
							<input
								type="number"
								required
								min={CRON_EVERY_MIN}
								max={schedule.preset === "minutes" ? CRON_EVERY_MAX_MINUTES : CRON_EVERY_MAX_HOURS}
								value={schedule.every}
								onChange={(event) => applySchedule({ every: event.target.value })}
							/>
						</label>
					) : null}
					{schedule.preset !== "advanced" && schedule.preset !== "minutes" && schedule.preset !== "hours" ? (
						<label className="cron-field">
							{t("时间", "Time")}
							<input
								type="time"
								required
								value={schedule.time}
								onChange={(event) => applySchedule({ time: event.target.value })}
							/>
						</label>
					) : null}
				</div>
				{schedule.preset === "advanced" ? (
					<div className="cron-fields">
						{fields.map((label, index) => (
							<label className="cron-field" key={index}>
								{label}
								<input
									required
									spellCheck={false}
									value={parts[index] ?? ""}
									onChange={(event) => {
										const next = Array.from({ length: 5 }, (_, i) => parts[i] ?? "");
										next[index] = event.target.value.replace(/\s/g, "");
										set("expression", next.join(" "));
									}}
								/>
							</label>
						))}
					</div>
				) : null}
				<code className="cron-expression">{draft.expression}</code>
				{schedule.preset === "minutes" || schedule.preset === "hours" ? (
					<p className="cron-hint">
						{t(
							`每 ${schedule.every} ${schedule.preset === "minutes" ? "分钟" : "小时"}运行一次（按整点对齐，如每 15 分钟在 :00 / :15 / :30 / :45）`,
							`Runs every ${schedule.every} ${schedule.preset === "minutes" ? "minutes" : "hours"} (aligned to the clock: every 15 minutes fires at :00 / :15 / :30 / :45)`,
						)}
					</p>
				) : null}
				<label className="cron-field">
					{t("时区", "Timezone")}
					<input
						required
						placeholder="Asia/Shanghai"
						spellCheck={false}
						value={draft.timezone}
						onChange={(event) => set("timezone", event.target.value)}
					/>
				</label>
				<label className="cron-toggle">
					<input type="checkbox" checked={draft.enabled} onChange={(event) => set("enabled", event.target.checked)} />
					{t("启用", "Enabled")}
				</label>
			</fieldset>
			<section className="cron-preview" aria-live="polite" aria-busy={canPreview && !currentPreview}>
				<strong>{t("下次运行预览", "Upcoming runs")}</strong>
				{!canPreview ? (
					<p>{t("请输入五字段表达式和时区。", "Enter a five-field expression and timezone.")}</p>
				) : !currentPreview ? (
					<p>{t("正在预览…", "Loading preview…")}</p>
				) : currentPreview.error ? (
					<p role="alert">{currentPreview.error}</p>
				) : currentPreview.times.length === 0 ? (
					<p>{t("没有即将运行的时间", "No upcoming runs")}</p>
				) : (
					<ul>
						{currentPreview.times.map((time, index) => (
							<li key={`${time}-${index}`}>
								<time dateTime={time}>{cronTime(time, true)}</time>
							</li>
						))}
					</ul>
				)}
			</section>
			<div className="cron-actions">
				<button
					className="btn btn-primary"
					type="submit"
					disabled={busy || !cronDraftReady(draft, workspaces) || !currentPreview || Boolean(currentPreview.error)}
				>
					{busy ? t("保存中…", "Saving…") : t("保存", "Save")}
				</button>
				<button className="btn" type="button" disabled={busy} onClick={onCancel}>
					{t("取消", "Cancel")}
				</button>
			</div>
		</form>
	);
}
