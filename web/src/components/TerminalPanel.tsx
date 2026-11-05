import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { basename } from "../path-utils.ts";
import { useT } from "../use-language.ts";
import { openStream, type Stream } from "../stream.ts";
import { TERMINAL_FONT_DEFAULT, TERMINAL_FONT_KEY, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from "../ui-prefs.ts";
import { useStoredNumber } from "../use-stored-number.ts";

/** 未发送输入的显示位置（相对 .terminal-panel，左上角） */
interface PendingEcho {
	text: string;
	left: number;
	top: number;
	cellH: number;
	fontSize: number;
	fontFamily: string;
}

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
	/** 还没回车 / Tab 发出去的输入：只在本地画在光标处（不写进 shell），位置由 xterm 光标算出 */
	const [pending, setPending] = useState<PendingEcho | null>(null);
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
			// 补上 Windows 字体：SFMono/Menlo 都没有，缺了就落到 Courier New，TUI 制表符会错位。
			// 2026-11-04（用户：「终端的字体被压扁了」）：`ui-monospace` / `Menlo` 提到 `Courier New` **前面** ——
			// 以前 macOS 上 Cascadia / Consolas 都没有，于是先命中 Courier New（细弱、带衬线的打字机体），
			// 再用系统等宽（SF Mono / Menlo）就正常了；Windows 上这几个全部落空，照旧落到 Courier New。
			fontFamily:
				'"Cascadia Mono", Consolas, ui-monospace, SFMono-Regular, Menlo, "Courier New", monospace',
			/**
			 * 行高：xterm 默认是 1.0，字号一大（⌘+滚轮可以调到 24px）字就上下贴着，
			 * 看着像被压扁（用户 2026-11-04）。1.2 是「不显挤、又不多占行」的常用值。
			 * **不会**影响列数：列宽只看字符宽度，行高只管纵向。
			 */
			lineHeight: 1.2,
			// 白底深字（用户 2026-11-05：终端换成白色样式）。ANSI 颜色按浅底取深一档，保证白底上看得清
			theme: {
				background: "#ffffff",
				foreground: "#24292f",
				cursor: "#24292f",
				cursorAccent: "#ffffff",
				selectionBackground: "rgb(9 105 218 / 22%)",
				black: "#24292f",
				red: "#cf222e",
				green: "#116329",
				yellow: "#7d4e00",
				blue: "#0969da",
				magenta: "#8250df",
				cyan: "#1b7c83",
				white: "#6e7781",
				brightBlack: "#57606a",
				brightRed: "#a40e26",
				brightGreen: "#1a7f37",
				brightYellow: "#633c01",
				brightBlue: "#218bff",
				brightMagenta: "#a475f9",
				brightCyan: "#3192aa",
				brightWhite: "#8c959f",
			},
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

		let source: Stream | null = null;
		let observer: ResizeObserver | null = null;
		let disposed = false;
		let started = false;
		// 先注册输入：/api/terminal/start 是异步的，等它回来之前敲的字不能丢
		const pending: string[] = [];
		/**
		 * 输入合并（用户 2026-11-05：「用户输入完，回车或是 tab 时再调 api，这样会快一些」）：
		 * 可见字符只攒在本地 `inputBuf` 里（不发请求），由 `.terminal-pending` 把正在输入的字显示在终端底部；
		 * 回车 / Tab 时把整行合并成**一次**请求发出。缓冲非空时退格只删本地缓冲，不发。
		 * 其它控制键（Ctrl+C、方向键、ESC 序列等）要即时生效，所以把缓冲与它合并后立即发出。
		 */
		const sendInput = (chunk: string) => {
			void fetch("/api/terminal/input", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: termId, data: chunk }),
			});
		};
		const emitInput = (chunk: string) => {
			if (started) sendInput(chunk);
			else pending.push(chunk);
		};
		/** 可见字符（不含 C0 控制字符与 DEL）：才进本地缓冲 */
		const isPlainText = (data: string): boolean => {
			if (!data) return false;
			for (const ch of data) {
				const code = ch.codePointAt(0) ?? 0;
				if (code < 0x20 || code === 0x7f) return false;
			}
			return true;
		};
		let inputBuf = "";
		/** 把未发送的字画到光标所在的格子上：格子尺寸取 .xterm-screen 的实际大小 ÷ 行列数 */
		const showPending = (text: string) => {
			if (!text) {
				setPending(null);
				return;
			}
			const screen = host.querySelector<HTMLElement>(".xterm-screen");
			const aside = host.parentElement;
			if (!screen || !aside || term.cols <= 0 || term.rows <= 0) {
				setPending({ text, left: 0, top: 0, cellH: 16, fontSize: term.options.fontSize ?? 12, fontFamily: String(term.options.fontFamily ?? "monospace") });
				return;
			}
			const cellW = screen.clientWidth / term.cols;
			const cellH = screen.clientHeight / term.rows;
			const origin = aside.getBoundingClientRect();
			const at = screen.getBoundingClientRect();
			const cursor = term.buffer.active;
			setPending({
				text,
				left: at.left - origin.left + cursor.cursorX * cellW,
				top: at.top - origin.top + cursor.cursorY * cellH,
				cellH,
				fontSize: term.options.fontSize ?? 12,
				fontFamily: String(term.options.fontFamily ?? "monospace"),
			});
		};
		// 光标挪动 / 尺寸变了（输出到来、拖高、字号）：未发送的字跟着光标走
		term.onCursorMove(() => {
			if (inputBuf) showPending(inputBuf);
		});
		term.onResize(() => {
			if (inputBuf) showPending(inputBuf);
		});
		term.onData((data) => {
			// 全屏程序（vim / less / top 等，xterm 的 alternate buffer）：按键必须逐个即时送达，
			// 不能攒在本地（否则 vim 里的 j/k 之类收不到）。先把攒着的字补发出去，保持顺序。
			if (term.buffer.active.type === "alternate") {
				const pendingChunk = inputBuf;
				inputBuf = "";
				setPending(null);
				emitInput(pendingChunk + data);
				return;
			}
			if (isPlainText(data)) {
				inputBuf += data;
				showPending(inputBuf);
				return;
			}
			if (data === "\x7f" && inputBuf) {
				inputBuf = Array.from(inputBuf).slice(0, -1).join("");
				showPending(inputBuf);
				return;
			}
			const chunk = inputBuf + data;
			inputBuf = "";
			showPending("");
			emitInput(chunk);
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
			for (const chunk of pending.splice(0)) sendInput(chunk);
			// 预置命令（如有）：补一个回车 = 人自己敲了一遍。必须等 start 回来后再发，
			// 否则 PTY 还没起来，这句只会被塞进 pending（顺序也对，排在用户已敲的字之后）
			if (initialCommand) {
				void fetch("/api/terminal/input", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: termId, data: `${initialCommand}\r` }),
				});
			}
			/**
			 * 收输出：**WebSocket**（`?terminal=<id>`），不是 SSE ——
			 * SSE 会永久占住浏览器给同一个 host 的一条 HTTP 连接，开几个终端就把 6 条占满，
			 * 连页面都加载不出来（用户 2026-11-04 撞到的「切会话卡死」）。
			 * 代理挡掉 Upgrade 时 `openStream` 会自动退回 SSE，行为不变。
			 */
			let retry = 0;
			const subscribe = () => {
				source = openStream({
					wsPath: `/ws?terminal=${encodeURIComponent(termId)}`,
					sseUrl: `/api/terminal/stream?id=${encodeURIComponent(termId)}`,
					handlers: {
						onOpen: () => {
							retry = 0;
						},
						onMessage: (data) => {
							try {
								term.write(JSON.parse(data) as string);
							} catch {
								term.write(data);
							}
						},
						// 服务端重启 / 终端被别的标签页关掉：自己按退避再连几次（最多 5 次），
						// 别让这一屏变成「黑着但还显示 PTY 已启动」的假状态
						onClose: () => {
							source = null;
							if (disposed || retry >= 5) return;
							retry += 1;
							setTimeout(() => {
								if (!disposed) subscribe();
							}, Math.min(500 * 2 ** retry, 8000));
						},
					},
				});
			};
			subscribe();
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
			{pending ? (
				<div
					className="terminal-pending"
					aria-live="polite"
					style={{
						left: pending.left,
						top: pending.top,
						fontSize: pending.fontSize,
						fontFamily: pending.fontFamily,
						lineHeight: `${pending.cellH}px`,
						maxWidth: `calc(100% - ${Math.round(pending.left)}px)`,
					}}
				>
					{pending.text}
				</div>
			) : null}
		</aside>
	);
}
