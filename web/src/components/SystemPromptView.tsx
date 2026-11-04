/**
 * 「系统提示词」：这条会话**这一次运行实际在用**的那段提示词，原样看、原样复制。
 *
 * 为什么要单独一张卡片，而不是从导出页里翻：导出页里那段（pi 的模板会带）只有
 * 真的导出过才在里面，而且它还埋在长页面顶部；改完 AGENTS.md / 技能之后想确认
 * 「模型到底收到了什么」，最顺手的动作就是点一下底部那颗按钮。
 *
 * 内容由 `/api/sessions/<id>/system-prompt` 现取（服务端问引擎的
 * `session.systemPrompt`，是 pi 的 resourceLoader 拼完的全文，不是我们抄的一份）。
 * 拿不到时**明说为什么**（引擎不提供 / 会话没打开），不画一块空白。
 */
import { useEffect, useState } from "react";
import { CopyButton } from "./CopyButton.tsx";
import { useT } from "../use-language.ts";

type View = { status: "loading" } | { status: "ready"; prompt: string } | { status: "error"; message: string };

export function SystemPromptView({ conversationId }: { conversationId: string | null }) {
	const t = useT();
	const [view, setView] = useState<View>({ status: "loading" });
	/** 重读次数：会话刚切过去、提示词还取不到时，不用关标签重开，点一下「重读」就行 */
	const [reloadSeq, setReloadSeq] = useState(0);

	useEffect(() => {
		if (!conversationId) {
			setView({ status: "error", message: t("先打开一条会话。", "Open a session first.") });
			return;
		}
		let cancelled = false;
		setView({ status: "loading" });
		fetch(`/api/sessions/${encodeURIComponent(conversationId)}/system-prompt`)
			.then(async (response) => {
				const body = (await response.json().catch(() => null)) as
					| { prompt?: unknown; error?: { message?: unknown } }
					| null;
				if (!response.ok) {
					const message =
						typeof body?.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
					throw new Error(message);
				}
				return typeof body?.prompt === "string" ? body.prompt : "";
			})
			.then((prompt) => {
				if (!cancelled) setView({ status: "ready", prompt });
			})
			.catch((error: unknown) => {
				if (!cancelled) setView({ status: "error", message: error instanceof Error ? error.message : String(error) });
			});
		return () => {
			cancelled = true;
		};
	}, [conversationId, reloadSeq, t]);

	if (view.status === "loading") {
		return <div className="session-view-empty">{t("正在读取系统提示词…", "Reading the system prompt…")}</div>;
	}
	if (view.status === "error") {
		return (
			<div className="session-view-empty session-view-error">
				<div>{view.message}</div>
				<button type="button" className="btn btn-tiny" onClick={() => setReloadSeq((value) => value + 1)}>
					{t("重读", "Retry")}
				</button>
			</div>
		);
	}

	const prompt = view.prompt;
	const lines = prompt === "" ? 0 : prompt.split("\n").length;
	return (
		<div className="session-prompt">
			<div className="session-prompt-head">
				<span className="session-prompt-meta">
					{lines > 0
						? t(`${lines} 行 · ${prompt.length.toLocaleString()} 字符`, `${lines} lines · ${prompt.length.toLocaleString()} chars`)
						: t("这段是空的", "This is empty")}
				</span>
				<span className="topbar-spacer" />
				{/* 会话刚切过去时引擎可能还没把提示词拼好：给一个就地重读的入口 */}
				<button
					type="button"
					className="btn btn-tiny"
					title={t("重新读取", "Read again")}
					onClick={() => setReloadSeq((value) => value + 1)}
				>
					↻
				</button>
				<CopyButton text={prompt} className="btn btn-tiny" title="复制系统提示词" />
			</div>
			<pre className="session-prompt-body">{prompt}</pre>
		</div>
	);
}
