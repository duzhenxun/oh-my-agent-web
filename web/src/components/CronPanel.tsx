import { useEffect, useRef, useState } from "react";
import {
	cronDraft,
	cronTime,
	deleteCron,
	fetchCronOptions,
	newCronDraft,
	runCron,
	saveCron,
	watchCron,
	type CronDraft,
	type CronJob,
	type CronOptions,
	type CronRun,
	type CronState,
} from "../cron.ts";
import { useT } from "../use-language.ts";
import { CronEditor } from "./CronEditor.tsx";

/** Independent scheduled tasks: v1 results stay plain text and never open an agent session. */
export function CronPanel() {
	const t = useT();
	const [data, setData] = useState<CronState | null>(null);
	// 会话 / 模型候选：只在面板打开时拉一次（内存里的清单，量很小，不必跟着轮询走）
	const [options, setOptions] = useState<CronOptions>({ sessions: [], models: [] });
	const [loadError, setLoadError] = useState("");
	const [actionError, setActionError] = useState("");
	const [revision, setRevision] = useState(0);
	const [busy, setBusy] = useState(false);
	const [editor, setEditor] = useState<{ id?: string; draft: CronDraft } | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [deleteId, setDeleteId] = useState<string | null>(null);
	const action = useRef<AbortController | null>(null);

	useEffect(
		() =>
			watchCron(
				(state) => {
					setData(state);
					setLoadError("");
				},
				(error) => setLoadError(error instanceof Error ? error.message : String(error)),
			),
		[revision],
	);
	useEffect(() => () => action.current?.abort(), []);
	useEffect(() => {
		const controller = new AbortController();
		void fetchCronOptions(controller.signal).then(
			(next) => {
				if (!controller.signal.aborted) setOptions(next);
			},
			() => undefined, // 拿不到就只显示「新建会话」：不因为一个下拉框把面板弄成报错
		);
		return () => controller.abort();
	}, [revision]);

	const perform = async (operation: (signal: AbortSignal) => Promise<void>): Promise<boolean> => {
		if (action.current) return false;
		const controller = new AbortController();
		action.current = controller;
		setBusy(true);
		setActionError("");
		try {
			await operation(controller.signal);
			if (controller.signal.aborted) return false;
			setRevision((value) => value + 1);
			return true;
		} catch (error) {
			if (!controller.signal.aborted) setActionError(error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			if (!controller.signal.aborted) {
				action.current = null;
				setBusy(false);
			}
		}
	};
	const status: Record<CronRun["status"], string> = {
		queued: t("排队中", "Queued"),
		running: t("运行中", "Running"),
		succeeded: t("已成功", "Succeeded"),
		failed: t("已失败", "Failed"),
		interrupted: t("已中断", "Interrupted"),
		skipped: t("已跳过", "Skipped"),
	};
	const edit = (job?: CronJob) => {
		setActionError("");
		setDeleteId(null);
		setEditor(job ? { id: job.id, draft: cronDraft(job) } : { draft: newCronDraft(data?.workspaces[0]) });
	};
	const jobs = data?.jobs ?? [];
	const nameOf = (id: string) => jobs.find((job) => job.id === id)?.name ?? t("（已删除的任务）", "(deleted job)");
	const runs = (data?.runs ?? []).filter((run) => selectedId === null || run.jobId === selectedId);

	return (
		<div className="cron-panel">
			<header className="cron-head">
				<h2>{t("定时任务", "Cron")}</h2>
				<div className="cron-actions">
					<button
						type="button"
						className="btn btn-tiny"
						disabled={busy}
						onClick={() => setRevision((value) => value + 1)}
					>
						{t("刷新", "Refresh")}
					</button>
					<button type="button" className="btn btn-tiny" disabled={busy || !data} onClick={() => edit()}>
						{t("新建任务", "New job")}
					</button>
				</div>
			</header>
			<p className="cron-hint">
				{t(
					"自动刷新。运行历史和结果仅以文本显示，不会打开普通代理会话。",
					"Refreshes automatically. Run history and results are shown as text; no regular agent session is opened.",
				)}
				{/* 任务按引擎分开存（用户 2026-11-24：「不同 agent 要区分开，各保存各的」）：
				 * 不写这一句，切引擎之后看到列表空/换了会以为任务丢了。 */}
				{data ? (
					<>
						{" "}
						{t(
							`任务按引擎分开保存，这里只显示 ${data.engine} 的任务。`,
							`Jobs are stored per engine — only ${data.engine} jobs are shown here.`,
						)}
					</>
				) : null}
			</p>
			{loadError ? (
				<div className="cron-error" role="alert">
					{loadError}
				</div>
			) : null}
			{actionError ? (
				<div className="cron-error" role="alert">
					{actionError}
				</div>
			) : null}
			{!data && !loadError ? <p role="status">{t("加载中…", "Loading…")}</p> : null}
			<div className="cron-layout">
				<section className="cron-jobs" aria-label={t("定时任务", "Cron")}>
					{data && jobs.length === 0 ? <p className="cron-hint">{t("暂无定时任务", "No scheduled jobs yet")}</p> : null}
					{jobs.map((job) => (
						<article className={`cron-job${selectedId === job.id ? " cron-job-selected" : ""}`} key={job.id}>
							<div className="cron-job-heading">
								<h3>{job.name}</h3>
								<span className="cron-job-tags">
									{job.mode === "agent" ? (
										<span className="cron-badge">{job.allowWrites ? t("Agent · 可写", "Agent · writes") : t("Agent · 只读", "Agent · read-only")}</span>
									) : (
										<span className="cron-badge cron-badge-plain">{t("文本", "Text")}</span>
									)}
									<span className="cron-hint">{job.enabled ? t("已启用", "Enabled") : t("已暂停", "Paused")}</span>
								</span>
							</div>
							<p className="cron-workspace">{job.workspace}</p>
							<p>
								<code>{job.expression}</code> · {job.timezone}
							</p>
							{job.mode === "agent" && (job.sessionId || job.model) ? (
								<p className="cron-hint">
									{job.sessionId
										? `${t("续跑会话", "Session")}: ${options.sessions.find((item) => item.id === job.sessionId)?.title ?? job.sessionId}`
										: t("每次新建会话", "New session each run")}
									{job.model ? ` · ${t("模型", "Model")}: ${job.model}` : ""}
								</p>
							) : null}
							<p className="cron-hint">
								{t("下次运行", "Next run")}:{" "}
								{job.nextRunAt ? <time dateTime={job.nextRunAt}>{cronTime(job.nextRunAt)}</time> : "—"}
							</p>
							<div className="cron-actions">
								<button type="button" className="btn btn-tiny" disabled={busy} onClick={() => edit(job)}>
									{t("编辑", "Edit")}
								</button>
								<button
									type="button"
									className="btn btn-tiny"
									disabled={busy}
									onClick={() =>
										void perform((signal) => saveCron({ ...cronDraft(job), enabled: !job.enabled }, job.id, signal))
									}
								>
									{job.enabled ? t("暂停", "Pause") : t("启用", "Enable")}
								</button>
								<button
									type="button"
									className="btn btn-tiny"
									disabled={busy}
									onClick={() => {
										setSelectedId(job.id);
										void perform((signal) => runCron(job.id, signal));
									}}
								>
									{t("立即运行", "Run now")}
								</button>
								<button
									type="button"
									className="btn btn-tiny"
									aria-pressed={selectedId === job.id}
									onClick={() => setSelectedId(selectedId === job.id ? null : job.id)}
								>
									{t("历史", "History")}
								</button>
								<button type="button" className="btn btn-tiny" disabled={busy} onClick={() => setDeleteId(job.id)}>
									{t("删除", "Delete")}
								</button>
							</div>
							{deleteId === job.id ? (
								<div className="cron-delete" role="group" aria-label={t("确认删除", "Confirm deletion")}>
									<span>{t("删除此定时任务？", "Delete this scheduled job?")}</span>
									<button
										type="button"
										className="btn btn-tiny"
										disabled={busy}
										onClick={() =>
											void perform((signal) => deleteCron(job.id, signal)).then((ok) => {
												if (!ok) return;
												setDeleteId(null);
												if (selectedId === job.id) setSelectedId(null);
												if (editor?.id === job.id) setEditor(null);
											})
										}
									>
										{t("确认删除", "Confirm deletion")}
									</button>
									<button type="button" className="btn btn-tiny" disabled={busy} onClick={() => setDeleteId(null)}>
										{t("取消", "Cancel")}
									</button>
								</div>
							) : null}
						</article>
					))}
				</section>
				<div className="cron-detail">
					{editor ? (
						<CronEditor
							key={editor.id ?? "new"}
							options={options}
							initial={editor.draft}
							workspaces={data?.workspaces ?? []}
							busy={busy}
							onCancel={() => setEditor(null)}
							onSave={async (draft) => {
								if (await perform((signal) => saveCron(draft, editor.id, signal))) setEditor(null);
							}}
						/>
					) : null}
					<section className="cron-history" aria-label={t("运行历史", "Run history")}>
						<div className="cron-job-heading">
							<h3>
								{t("运行历史", "Run history")}
								{selectedId ? ` · ${nameOf(selectedId)}` : ""}
							</h3>
							{selectedId ? (
								<button type="button" className="btn btn-tiny" onClick={() => setSelectedId(null)}>
									{t("全部任务", "All jobs")}
								</button>
							) : null}
						</div>
						{data && runs.length === 0 ? <p className="cron-hint">{t("暂无运行记录", "No runs yet")}</p> : null}
						{runs.map((run) => (
							<details className="cron-run" key={run.id}>
								<summary>
									<span className={`cron-status cron-status-${run.status}`}>{status[run.status]}</span>
									<span>{nameOf(run.jobId)}</span>
									<span className="cron-hint">
										{run.trigger === "manual" ? t("手动", "Manual") : t("计划", "Scheduled")}
									</span>
									<time dateTime={run.startedAt ?? run.scheduledAt}>{cronTime(run.startedAt ?? run.scheduledAt)}</time>
								</summary>
								<dl>
									{[
										[t("计划时间", "Scheduled at"), run.scheduledAt],
										[t("开始时间", "Started at"), run.startedAt],
										[t("结束时间", "Finished at"), run.finishedAt],
									].map(([label, time]) =>
										time ? (
											<div key={label}>
												<dt>{label}</dt>
												<dd>
													<time dateTime={time}>{cronTime(time)}</time>
												</dd>
											</div>
										) : null,
									)}
								</dl>
								{run.result !== undefined ? (
									<div>
										<h4>{t("结果", "Result")}</h4>
										<pre className="cron-result">{run.result}</pre>
									</div>
								) : null}
								{run.error !== undefined ? (
									<div>
										<h4>{t("错误", "Error")}</h4>
										<pre className="cron-result cron-error">{run.error}</pre>
									</div>
								) : null}
							</details>
						))}
					</section>
				</div>
			</div>
		</div>
	);
}
