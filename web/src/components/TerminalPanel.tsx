import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { basename } from "../path-utils.ts";
import { useT } from "../use-language.ts";
import { TERMINAL_FONT_DEFAULT, TERMINAL_FONT_KEY, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from "../ui-prefs.ts";
import { useStoredNumber } from "../use-stored-number.ts";

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
	initialCommand = null,
	standalone = false,
	active = true,
	onClose,
}: {
	/** 终端 id：多终端互不干扰，切换标签不重建 */
	termId: string;
	cwd?: string | null;
	/**
	 * 建好 PTY 后自动敲进去的命令（末尾自动补回车）。
	 * 用在抬头「↑ 有新版」→ 点一下就开终端跑升级，省得人复制粘贴；普通终端不传（null）。
	 */
	initialCommand?: string | null;
	/** 独立使用时才显示内部标题栏；嵌入面板默认不显示（标签上已有信息） */
	standalone?: boolean;
	/** 是否当前激活的标签：切回来时要 refit + 抢回焦点（否则键盘打不进去） */
	active?: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const hostRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [ready, setReady] = useState(false);
	/**
	 * 字号（设置 → 外观 → 「终端字号」里也能改，⚠ 同一个 key）：默认 12px。
	 *
	 * 为什么要可调（用户 2026-10-30：「右侧终端文字有时太小」）：12 是当时随手定的值，
	 * 大屏上偏小、小屏上又占地方。三个入口写的是同一份偏好：
	 *   · 终端里 **⌘/Ctrl + 滚轮**（往下滚变小、往上滚变大 —— 跟终端/编辑器的习惯一致）；
	 *   · 终端里 **⌘/Ctrl + `=` / `+` / `-`**（`0` 恢复默认，见下面的 onKeyDown）；
	 *   · 设置 → 外观里的滑杆。
	 */
	const [fontPx, setFontPx] = useStoredNumber(
		TERMINAL_FONT_KEY,
		TERMINAL_FONT_DEFAULT,
		TERMINAL_FONT_MIN,
		TERMINAL_FONT_MAX,
	);
	/** xterm 实例：改字号要直接改它，然后 refit（不重建终端 —— 重建会把 shell 输出 / 历史全丢掉） */
	const termRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const fontPxRef = useRef(fontPx);
	fontPxRef.current = fontPx;

	// 切回这个标签时：重新 fit（隐藏期间容器宽高是 0）+ 把焦点还给终端
	const refitRef = useRef<(() => void) | null>(null);
	useEffect(() => {
		if (!active) return;
		// 下一帧再动，等 display 从 none 变回 flex
		const timer = setTimeout(() => refitRef.current?.(), 30);
		return () => clearTimeout(timer);
	}, [active]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const term = new Terminal({
			// 初值取当前偏好；之后由下面那个 effect 跟着改（不重建终端）
			fontSize: fontPxRef.current,
			// 补上 Windows 字体：SFMono/Menlo 都没有，缺了就落到 Courier New，TUI 制表符会错位
			fontFamily: '"Cascadia Mono", Consolas, "Courier New", ui-monospace, SFMono-Regular, Menlo, monospace',
			theme: { background: "#0d1117", foreground: "#c9d1d9" },
			cursorBlink: true,
			scrollback: 2000,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();
		termRef.current = term;
		fitRef.current = fit;

		/**
		 * ⌘/Ctrl + 滚轮 = 改字号。要 `passive: false` 才能 preventDefault ——
		 * 否则浏览器会同时把整页放大/缩小（那会连带把侧栏、对话一起缩放，不是用户想要的）。
		 * 用 ref 读当前值：这个监听只挂一次，不该因为字号变化反复解绑重挂。
		 */
		const onWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			const step = event.deltaY < 0 ? 2 : -2;
			setFontPx(fontPxRef.current + step);
		};
		host.addEventListener("wheel", onWheel, { passive: false });

		/**
		 * ⌘/Ctrl + `+` / `-` / `0`：键盘那条路（用户 2026-10-30：「点在这里面，Ctrl 加 + 或 - 时
		 * 这个终端里的文字要变大变小」）。
		 *
		 * 为什么挂在 host 的**捕获阶段**、而不是只靠 xterm 的 `attachCustomKeyEventHandler`：
		 *   - 那条路只有在焦点正好落在 xterm 的隐藏 textarea 上时才走得到；
		 *   - 而且它 `return false` 只是「xterm 不处理这个键」，**不会** preventDefault ——
		 *     于是浏览器把 Ctrl+`=` 当成「页面放大」，整页（侧栏、对话一起）放大缩小，正是要避免的。
		 * 捕获阶段先拦住并 `preventDefault + stopPropagation`：浏览器不缩放、xterm 也不会把 `=` 送进 shell。
		 */
		const onKeyDown = (event: KeyboardEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			// AltGr 在 Windows 上会带 ctrl+alt，别把人家输入特殊字符的手势抢了
			if (event.altKey) return;
			const zoomIn = event.key === "+" || event.key === "=" || event.code === "NumpadAdd";
			const zoomOut = event.key === "-" || event.key === "_" || event.code === "NumpadSubtract";
			const reset = event.key === "0" || event.code === "Numpad0";
			if (!zoomIn && !zoomOut && !reset) return;
			event.preventDefault();
			event.stopPropagation();
			if (zoomIn) setFontPx(fontPxRef.current + 2);
			else if (zoomOut) setFontPx(fontPxRef.current - 2);
			else setFontPx(TERMINAL_FONT_DEFAULT);
		};
		host.addEventListener("keydown", onKeyDown, true);

		let source: EventSource | null = null;
		let observer: ResizeObserver | null = null;
		let disposed = false;
		let started = false;
		// 先注册输入：/api/terminal/start 是异步的，等它回来之前敲的字不能丢
		const pending: string[] = [];
		term.onData((data) => {
			if (!started) {
				pending.push(data);
				return;
			}
			void fetch("/api/terminal/input", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: termId, data }),
			});
		});
		// 尺寸变化 → 服务端（否则 vim / top 的布局会错）
		term.onResize(
			({ cols, rows }) =>
				void fetch("/api/terminal/resize", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: termId, cols, rows }),
				}),
		);

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
			// start 成功：把「输入已就绪」打开，并把启动前敲的字补发出去
			// （之前漏了这句：所有按键都被当成"未启动"塞进 pending，永远发不出去 → 输入丢失）
			started = true;
			for (const chunk of pending.splice(0)) {
				void fetch("/api/terminal/input", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: termId, data: chunk }),
				});
			}
			// 预置命令（如有）：补一个回车 = 人自己敲了一遍。必须等 start 回来后再发，
			// 否则 PTY 还没起来，这句只会被塞进 pending（顺序也对，排在用户已敲的字之后）
			if (initialCommand) {
				void fetch("/api/terminal/input", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: termId, data: `${initialCommand}\r` }),
				});
			}
			// SSE 收输出
			source = new EventSource(`/api/terminal/stream?id=${encodeURIComponent(termId)}`);
			source.onmessage = (event) => {
				try {
					term.write(JSON.parse(event.data) as string);
				} catch {
					term.write(event.data);
				}
			};
			// 存在 effect 作用域里：卸载时要 disconnect（以前它建在 async 回调里，清理拿不到）
			observer = new ResizeObserver(() => fit.fit());
			observer.observe(host);
			refitRef.current = () => {
				fit.fit();
				term.focus();
			};
			term.focus();
		})();

		return () => {
			disposed = true;
			host.removeEventListener("wheel", onWheel);
			host.removeEventListener("keydown", onKeyDown, true);
			termRef.current = null;
			fitRef.current = null;
			observer?.disconnect();
			source?.close();
			// 必须带 id：服务端 `/api/terminal/stop` 是「按 id 杀进程」，空 id 直接 no-op，
			// 否则关掉面板后那个 shell 会一直留在服务端（孤儿进程）。
			void fetch("/api/terminal/stop", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: termId }),
			});
			term.dispose();
		};
	}, [cwd, termId, initialCommand]);

	/**
	 * 字号变了：直接改 xterm 的 option，然后 refit。
	 * **不能重建终端** —— 那会把这一路 shell 的字、历史、滚动位置全丢掉。
	 * refit 之后 onResize 会把新的 cols/rows 报给服务端，vim / top 的布局才跟着对。
	 */
	useEffect(() => {
		const term = termRef.current;
		if (!term) return;
		if (term.options.fontSize === fontPx) return;
		term.options.fontSize = fontPx;
		fitRef.current?.fit();
	}, [fontPx]);

	return (
		<aside className={`terminal-panel${standalone ? "" : " terminal-panel-embedded"}`}>
			{standalone ? (
				<div className="terminal-head">
					<span>
						⌨ {t("终端", "Terminal")}
						{cwd ? ` · ${basename(cwd)}` : ""}
					</span>
					<span className="side-panel-count">{ready ? t("PTY 已启动", "PTY running") : t("启动中…", "Starting…")}</span>
					<span className="topbar-spacer" />
					<button type="button" className="btn btn-tiny" onClick={onClose}>
						{t("关闭", "Close")}
					</button>
				</div>
			) : null}
			{error ? <div className="file-preview-error">{error}</div> : null}
			<div className="terminal-host" ref={hostRef} />
		</aside>
	);
}
