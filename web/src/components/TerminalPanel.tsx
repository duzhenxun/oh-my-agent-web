import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

/**
 * 终端面板（ADR-0027）：xterm + SSE。
 *
 * 三件事：
 *   1. 打开时 POST /api/terminal/start 起 PTY（cwd = 当前会话工作区）；
 *   2. SSE 读输出、键盘输入 POST 回去、尺寸变化报给服务端（否则 vim 显示会错位）；
 *   3. 关闭时 POST /api/terminal/stop，**不留孤儿 shell**。
 */
export function TerminalPanel({
	termId,
	cwd,
	embedded,
	onClose,
}: {
	/** 终端 id：多终端互不干扰，切换标签不重建 */
	termId: string;
	cwd?: string | null;
	embedded?: boolean;
	onClose: () => void;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const term = new Terminal({
			fontSize: 12,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			theme: { background: "#0d1117", foreground: "#c9d1d9" },
			cursorBlink: true,
			scrollback: 2000,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();

		let source: EventSource | null = null;
		let disposed = false;

		void (async () => {
			const response = await fetch("/api/terminal/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: termId, cols: term.cols, rows: term.rows, ...(cwd ? { cwd } : {}) }),
			});
			const body = (await response.json()) as { error?: { message?: string } };
			if (disposed) return;
			if (!response.ok) {
				setError(body.error?.message ?? `HTTP ${response.status}`);
				return;
			}
			setReady(true);
			// SSE 收输出
			source = new EventSource(`/api/terminal/stream?id=${encodeURIComponent(termId)}`);
			source.onmessage = (event) => {
				try {
					term.write(JSON.parse(event.data) as string);
				} catch {
					term.write(event.data);
				}
			};
			// 键盘 → 服务端
			term.onData(
				(data) =>
					void fetch("/api/terminal/input", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ data }),
					}),
			);
			// 尺寸变化 → 服务端（否则 vim / top 的布局会错）
			term.onResize(
				({ cols, rows }) =>
					void fetch("/api/terminal/resize", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ cols, rows }),
					}),
			);
			const observer = new ResizeObserver(() => fit.fit());
			observer.observe(host);
			term.focus();
		})();

		return () => {
			disposed = true;
			source?.close();
			void fetch("/api/terminal/stop", { method: "POST" });
			term.dispose();
		};
	}, [cwd, termId]);

	return (
		<aside className={`terminal-panel${embedded ? " terminal-panel-embedded" : ""}`}>
			<div className="terminal-head">
				<span>⌨ 终端{cwd ? ` · ${cwd.split("/").filter(Boolean).pop()}` : ""}</span>
				{ready ? (
					<span className="side-panel-count">PTY 已启动</span>
				) : (
					<span className="side-panel-count">启动中…</span>
				)}
				<span className="topbar-spacer" />
				<button type="button" className="btn btn-tiny" onClick={onClose}>
					关闭
				</button>
			</div>
			{error ? <div className="file-preview-error">{error}</div> : null}
			<div className="terminal-host" ref={hostRef} />
		</aside>
	);
}
