import { useState } from "react";

import { REPO_URL } from "../brand.ts";
import { lastCrash } from "./ErrorBoundary.tsx";
import { bugIssueTitle, bugIssueUrl, bugReportText, type BugReport } from "../bug-report.ts";
import { copyText } from "../clipboard.ts";
import { useAppSelector } from "../store.ts";
import { showToast } from "../toast.ts";
import { useT } from "../use-language.ts";

/**
 * 「提 Bug」面板：填一句「什么坏了」，点一下带着现场去 GitHub 开 issue。
 *
 * 为什么要做成面板而不是一个外链：只给一个 GitHub 链接，用户点进去面对一张空表单，
 * 九成只会写「用不了」——回来还得问三轮版本号、引擎、模型。现场是**我们手上就有**的，
 * 让它自己跟着走，用户只需要描述现象。
 *
 * 提交地址是仓库自己的 issues（`REPO_URL`，见 `brand.ts`）；正文由 `bug-report.ts` 的
 * 纯函数生成（脱敏 / 截断 / 编码都在那边，这里不拼字符串）。
 */
/**
 * 上次界面崩溃的现场，直接铺进「多写两句」里（可删）。
 *
 * 为什么放在这儿而不是藏在某个诊断入口：崩溃过的人手上正好有这条 issue 要提，
 * 让他再去找一遍堆栈等于没加。堆栈只取前 12 行（GitHub 正文不需要整段）。
 */
function crashPrefill(): string {
	const crash = lastCrash();
	if (crash === null) return "";
	const when = new Date(crash.at).toLocaleString();
	const stack = crash.detail.split("\n").slice(0, 12).join("\n").trim();
	return [`【上次界面出错 ${when}】`, crash.message, stack].filter((part) => part !== "").join("\n");
}

export function BugPanel() {
	const t = useT();
	const snapshot = useAppSelector((state) => state.snapshot);
	const [summary, setSummary] = useState("");
	const [detail, setDetail] = useState(crashPrefill);

	const report: BugReport = {
		summary,
		detail,
		version: snapshot?.versions.web ?? null,
		engine: snapshot?.engine ?? null,
		engineVersion: snapshot?.versions.engine ?? null,
		model: snapshot?.model ?? null,
		sessionId: snapshot?.active.conversationId ?? null,
		// 平台串里带着浏览器 / 系统版本，是排查「只有某个环境复现」的关键
		platform: typeof navigator === "undefined" ? "" : navigator.userAgent,
	};
	/** 标题为空就不让提交：空标题的 issue 在列表里等于没写 */
	const ready = bugIssueTitle(report) !== "";

	/**
	 * 开 GitHub 的新建 issue 页。
	 *
	 * 走 `window.open` 而不是 `<a target="_blank">`：同一份代码在浏览器里开新标签，
	 * 也方便以后按需改成其它宿主。
	 */
	const submit = (): void => {
		if (!ready) return;
		window.open(bugIssueUrl(report), "_blank", "noopener,noreferrer");
	};

	const copy = async (): Promise<void> => {
		const ok = await copyText(bugReportText(report));
		showToast({
			text: ok
				? t("报告已复制，可以直接粘到群里或邮件里", "Report copied — paste it anywhere")
				: t("复制失败：浏览器不让写剪贴板", "Copy failed: the browser blocked the clipboard"),
		});
	};

	return (
		<div className="bug-panel">
			<h2>{t("提 Bug", "Report a bug")}</h2>
			<p className="settings-hint">
				{t(
					"会打开 GitHub 的新建 issue 页面，标题和正文已经填好（版本 / 引擎 / 模型等现场信息自动带上）。issue 是公开的，不想公开的内容可以在提交前删掉。",
					"Opens the GitHub new-issue form with the title and body prefilled (version, engine, model and other context are attached automatically). Issues are public — delete anything you would rather not share before submitting.",
				)}
			</p>

			<label className="bug-field">
				<span className="settings-field">{t("一句话：什么坏了", "In one line: what broke")}</span>
				<input
					className="bug-input"
					value={summary}
					onChange={(event) => setSummary(event.target.value)}
					placeholder={t("比如：点发送后消息被顶栏挡住了", "e.g. my sent message is hidden behind the top bar")}
				/>
			</label>

			<label className="bug-field">
				<span className="settings-field">{t("多写两句（可空）", "More detail (optional)")}</span>
				<textarea
					className="bug-textarea"
					value={detail}
					onChange={(event) => setDetail(event.target.value)}
					rows={5}
					placeholder={t(
						"期望看到什么、实际看到什么、怎么复现（先点了哪里、再点了哪里）",
						"What you expected, what actually happened, and the steps to reproduce",
					)}
				/>
			</label>

			<div className="bug-actions">
				<button type="button" className="btn btn-tiny" onClick={submit} disabled={!ready}>
					{t("在 GitHub 新建 issue", "Open a GitHub issue")}
				</button>
				<button type="button" className="btn btn-tiny" onClick={() => void copy()}>
					{t("复制报告", "Copy report")}
				</button>
				<span className="settings-hint">
					{t("仓库：", "Repo: ")}
					<a href={REPO_URL} target="_blank" rel="noopener noreferrer">
						{REPO_URL.replace(/^https:\/\//, "")}
					</a>
				</span>
			</div>

			{/* 现场预览：让用户先看清「到底会带出去什么」，比任何说明都可信 */}
			<details className="bug-preview">
				<summary>{t("提交时会带上这些信息", "What gets attached")}</summary>
				<pre>{bugReportText({ ...report, summary: summary || "（未填写标题）", detail })}</pre>
			</details>
		</div>
	);
}
