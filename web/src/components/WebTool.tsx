/**
 * 右侧分栏里的「网页」页：地址栏 + iframe。
 *
 * 为什么是 iframe：本地服务不设 `X-Frame-Options` / `frame-ancestors`，直接嵌最省事，
 * 也不需要（更不该）为此开一个能代理任意站点的后端（那是 SSRF 的口子）。
 * 代价写在界面上：**对方站点自己拒绝被嵌**时（GitHub、Google 之类），面板里会是空白，
 * 这时点「在浏览器打开」跳出去 —— 不假装我们能做到任意网页都能嵌。
 *
 * 「标注」那颗钮（📍，在刷新右边）：进入拾取模式后**点页面上哪儿，就在那块旁边弹出一个小输入框**，
 * 写一句「这里要改成什么」回车就收进输入框那颗「N 条注释」（跟对话里选文字标的是同一个列表），
 * 确认之后**继续拾取** —— 一次能连着标好几处，发送时整批一起走。
 *
 * 输入框为什么在页面里而不在面板里：沙箱 iframe 没有同源，父窗口拿不到它的 DOM，
 * 也就没法把框贴在那一块旁边；所以编辑框由注进页面的脚本自己画
 * （`server/web-proxy/picker-script.ts`）。那条消息**不可信**（那个 window 里也跑着别人的页面脚本），
 * 所以只当它是一条普通注释，跟其它注释一样可以随时删。
 *
 * 页面上的橙色编号框由 `annotations` 推出来（受控）：在注释列表里删掉一条，页面上那个框
 * 也跟着消失；编号就是「N 条注释」列表里的同一个序号。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeUrl, proxyUrlOf, targetOfProxyUrl, wrapperUrlOf } from "../url-bar.ts";
import { useT } from "../use-language.ts";
import { usePanelZoom } from "../panel-zoom.ts";
import { readStored, WEB_PHONE_KEY, WEB_PHONE_SIZE_KEY, WEB_ZOOM_KEY, writeStored } from "../ui-prefs.ts";
import { useStoredBool } from "../use-stored-bool.ts";
import { fitScale, PHONE_PRESETS, phonePresetOf } from "../phone-frame.ts";
import { readPickerEvent, type WebNote, type WebNoteWithNumber } from "../web-note.ts";
import {
	addWebMark,
	marksOfPage,
	onWebMarksChange,
	readWebMarks,
	removePageMarks,
	writeWebMarks,
	type PageMark as Mark,
} from "../web-marks.ts";

const SUGGESTIONS = ["http://localhost:3000", "https://www.baidu.com", "https://developer.mozilla.org"];

/**
 * 沙箱权限。**两套**，区别只在最后一个 `allow-same-origin`：
 *
 *   - `SANDBOX_OPAQUE`：iframe 的文档是不透明源。代理把我们这个源上的别人的页面发出去，
 *     再给 same-origin 就等于把工作台的 localStorage / 会话 cookie / RPC 全交给远端 JS ——
 *     所以**直接嵌页面时必须有它**。代价：页面读 cookie / `window.parent` 会抛 SecurityError，
 *     有的页面（映客那类带 WebView 桥的）启动就挂，只剩自己的底色 → 看着是黑屏；
 *   - `SANDBOX_SAME_ORIGIN`：给外面那层**同源外壳**（`/web/w`，跑在兄弟回环主机上）用的。
 *     它自己与页面同源、与工作台不同源，所以这个权限的受益者是一个**隔离的**源：
 *     页面能读自己的 cookie / parent 了（于是能渲染），但读不到工作台的存储。
 */
const SANDBOX_OPAQUE =
	"allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";
const SANDBOX_SAME_ORIGIN = `${SANDBOX_OPAQUE} allow-same-origin`;

/**
 * 页面上一处标记（编号框 + 悬停能看到那句意见）。
 *
 * 这份名单**落盘**（本机 localStorage，按页存）：注释发出去就被清空了，
 * 但页面上已经标过的位置要一直留着号 —— 关掉浏览器再回来也得还在。
 * 读写 / 发号 / 裁剪都在 `web-marks.ts`。
 */

/**
 * iframe 里报回来的地址是**代理**地址（`/web/p/http/host/path`），面板里记的是原网址。
 * 两边必须换算成同一个再比，不然「这一页标了几处」永远对不上（编号框一个也画不出来），
 * 写进注释的地址也会是一串内部路径。
 */
function originalUrlOf(url: string): string {
	return targetOfProxyUrl(url) ?? url;
}

/**
 * 本机存储：无痕模式 / 被策略禁用时连 `window.localStorage` 都可能抛错，所以包一层。
 * 拿不到就返回 null —— 整条链路按「不落盘」跑，标记照样能标。
 */
function storageOrNull(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

/** 发进 iframe 的消息形状（与 `picker-script.ts` 里的 `message` 监听严格对应） */
type PickerCommand =
	| { type: "on" }
	| { type: "off" }
	| { type: "cancel" }
	| { type: "marks"; list: { selector: string; number: number; comment: string }[] };

export function WebTool({
	initialUrl = "",
	onAddNote,
}: {
	initialUrl?: string;
	/**
	 * 收下一条网页标注（进「N 条注释」，不动草稿）：不传就不画那颗 📍。
	 * 传进去的带上这一处在页面上的编号（由本组件按拾取顺序发，跨批次不重号）。
	 */
	onAddNote?: (note: WebNoteWithNumber) => void;
}) {
	const t = useT();
	/** 历史栈：iframe 没法和浏览器历史同步，自己记一份（后退/前进就是换 src） */
	const [history, setHistory] = useState<string[]>(initialUrl ? [initialUrl] : []);
	const [index, setIndex] = useState(initialUrl ? 0 : -1);
	const [draft, setDraft] = useState(initialUrl);
	const [error, setError] = useState<string | null>(null);
	/** 刷新：src 不变时改 key 才会真的重新加载 */
	const [reloadSeq, setReloadSeq] = useState(0);
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	/**
	 * ⌘/Ctrl + `+` / `-` 只缩放页面内容（居中那层 iframe），地址栏保持原样 ——
	 * 见 panel-zoom.ts 里关于「为什么挂在 window 捕获阶段」和 iframe 焦点边界的说明。
	 */
	const zoom = usePanelZoom(WEB_ZOOM_KEY);

	/**
	 * 手机尺寸预览：把 iframe 装进一台「机身」里（宽度就是页面的视口宽度）。
	 *
	 * 页面里的 `@media (max-width: …)` 看的是 iframe 自己的宽度，所以收窄到 390px 之后
	 * 断点、弹性布局、换行全都按手机那一档走 —— 这是响应式稿子唯一真正要看的东西。
	 * 设备相关的那部分（UA / DPR / 触屏）在沙箱 iframe 里改不了，不去假装能改。
	 */
	const [phone, setPhone] = useStoredBool(WEB_PHONE_KEY, false);
	const [phoneSize, setPhoneSize] = useState(() => readStored(WEB_PHONE_SIZE_KEY));
	const preset = useMemo(() => phonePresetOf(phoneSize), [phoneSize]);
	/** 📱 点开的机型菜单（关闭 / 选机型） */
	const [phoneMenuOpen, setPhoneMenuOpen] = useState(false);
	const phoneMenuRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!phoneMenuOpen) return;
		const onDown = (event: MouseEvent) => {
			if (!phoneMenuRef.current?.contains(event.target as Node)) setPhoneMenuOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setPhoneMenuOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [phoneMenuOpen]);
	/** 装手机的那层有多大：放不下整台就等比缩小（见 `fitScale`），永远不放大 */
	const stageRef = useRef<HTMLDivElement | null>(null);
	const [stage, setStage] = useState({ width: 0, height: 0 });
	useEffect(() => {
		const host = stageRef.current;
		if (host === null) return;
		const apply = () => setStage({ width: host.clientWidth, height: host.clientHeight });
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(host, { box: "content-box" });
		return () => observer.disconnect();
	}, []);
	const phoneScale = phone ? fitScale(stage, preset) : 1;

	const current = index >= 0 ? history[index] : "";
	/**
	 * 这一页跑在哪儿：**同源外壳**的地址（`/web/w`，兄弟回环主机上），拿不到时是 null。
	 *
	 * 为什么要外壳：面板里的 iframe 是不透明源（沙箱不给 `allow-same-origin`，给了就等于把
	 * 工作台的存储交给远端 JS），而不少页面启动就要读 `document.cookie` / `localStorage`，
	 * 一抛错整页就只剩底色（看着是黑屏）。外壳与页面同源、与工作台不同源 —— 两件事同时成立。
	 *
	 * 仍有两道过不去的：① 页面要求自己是**顶层窗口**（读 `window.top.xxx` 且不 try/catch）——
	 * 子框架里必然抛错，`window.top` 又不可改写，面板里目前没有办法绕过（已去掉「新窗口」按钮）；
	 * ② 远程访问 / https / 非 http(s) 网址时没有兄弟回环主机可用，退回原来的不透明沙箱。
	 */
	const shellSrc = useMemo(
		() =>
			current
				? wrapperUrlOf(
						current,
						{
							protocol: window.location.protocol,
							hostname: window.location.hostname,
							port: window.location.port,
						},
						// 手机预览要连 UA 一起换：站点是按 UA 决定发哪一版的（见 proxyUrlOf 的注释）
						{ mobile: phone },
					)
				: null,
		[current, phone],
	);
	const frameSrc = shellSrc ?? proxyUrlOf(current, { mobile: phone }) ?? current;
	const frameSandbox = shellSrc === null ? SANDBOX_OPAQUE : SANDBOX_SAME_ORIGIN;
	const canNote = onAddNote !== undefined;
	/**
	 * 回调放 ref 里：消息监听只订阅一次，不会因为上层每帧新建一个回调而反复挂/摘 ——
	 * 反复挂摘那个窗口意味着「刚好那一刻到的 note」会丢。
	 */
	const onAddNoteRef = useRef(onAddNote);
	useEffect(() => {
		onAddNoteRef.current = onAddNote;
	}, [onAddNote]);

	/** 拾取模式开着没有（按钮的按下态 + 页面上那个十字光标） */
	const [picking, setPicking] = useState(false);

	/** 标过的所有位置（本机落盘；按页记号，一处一号，不复用） */
	/**
	 * 整页刷新后标记不保留：开页时把落盘的那份清掉，从空开始。
	 * 本次会话内新标的仍然会同步、落盘（只是下次开页前清空）。
	 */
	const [marks, setMarks] = useState<Mark[]>(() => {
		writeWebMarks(storageOrNull(), []);
		return [];
	});
	/** 事件里要读最新的名单（setMarks 是异步的，不能拿闭包里那份） */
	const marksRef = useRef<Mark[]>(marks);
	useEffect(() => {
		marksRef.current = marks;
	}, [marks]);
	/**
	 * 标记从别处被删了（对话框里删掉一条网页注释）：重读一次落盘的名单，页面上的框跟着没。
	 * 自己写的那次也会触发一回，读出来的内容一样，只是白画一遍，不影响结果。
	 */
	useEffect(
		() =>
			onWebMarksChange(() => {
				const next = readWebMarks(storageOrNull());
				marksRef.current = next;
				setMarks(next);
			}),
		[],
	);

	/** 当前这一页标过的几处（按编号排好）：换页只显示本页的 */
	const marksHere = useMemo<Mark[]>(() => marksOfPage(marks, originalUrlOf(current)), [marks, current]);

	const send = useCallback((command: PickerCommand) => {
		frameRef.current?.contentWindow?.postMessage({ __aw: "picker", ...command }, "*");
	}, []);

	/**
	 * 在页面这份名单里记下一处（同一处再来一次 = 改那句意见，号不变），再交给上层进注释列表。
	 *
	 * 为什么号要在这里发：注释列表发完会清空，而页面上的号得一直排下去（用户要求 1,2,3,4…）；
	 * 号先定下来，页面徒标、胶囊那一行、发出去那段才会是同一个号。
	 */
	const record = useCallback((note: WebNote) => {
		const url = originalUrlOf(note.url);
		const next = addWebMark(marksRef.current, { url, selector: note.selector, comment: note.comment });
		const saved = next.find((mark) => mark.url === url && mark.selector === note.selector);
		marksRef.current = next;
		setMarks(next);
		writeWebMarks(storageOrNull(), next);
		onAddNoteRef.current?.({ ...note, url, number: saved?.number ?? 1 });
	}, []);

	/** 清掉这一页的所有标记（清完下一次标又是第 1 处） */
	const clearMarks = () => {
		const next = removePageMarks(marksRef.current, originalUrlOf(current));
		marksRef.current = next;
		setMarks(next);
		writeWebMarks(storageOrNull(), next);
	};

	/** 页面上的编号框（推送形状就三样：选择器、序号、那句意见） */
	const pushMarks = useCallback(() => {
		send({
			type: "marks",
			list: marksHere.map((mark) => ({ selector: mark.selector, number: mark.number, comment: mark.comment })),
		});
	}, [marksHere, send]);

	useEffect(pushMarks, [pushMarks]);

	// 换页 / 刷新：拾取状态归零（新文档里那段脚本是全新的）
	useEffect(() => {
		setPicking(false);
	}, [current, reloadSeq]);

	/**
	 * Esc 退出拾取。
	 *
	 * 为什么父窗口要自己再挂一份：页面里那段脚本只听**自己那个文档**的键盘事件。
	 * 刚点完 📍 时焦点在按钮上（面板这一侧），Esc 根本进不了 iframe —— 表现就是
	 * 「说好 Esc 能退出，按了没反应」。两边各挂一份，哪边有焦点都能退。
	 */
	useEffect(() => {
		if (!picking) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			send({ type: "off" });
			setPicking(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [picking, send]);

	/**
	 * iframe 回来的消息。
	 *
	 * 只认 `event.source === 那一帧的 contentWindow`：`event.origin` 在沙箱 iframe 里
	 * 恒为 `"null"`（不透明源），拿它认不出是谁发的。
	 */
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const frame = frameRef.current;
			if (frame === null || event.source !== frame.contentWindow) return;
			const message = readPickerEvent(event.data);
			if (message === null) return;
			if (message.kind === "ready") {
				// 新文档（首次打开 / 页面里点链接跳走）：编号框重画，拾取模式也跟着恢复
				pushMarks();
				// 不重发状态的话：按钮亮着，新文档里却没在拾取，点了没反应
				setPicking((on) => {
					if (on) send({ type: "on" });
					return on;
				});
				return;
			}
			// 页面“我是空的”的信号不再弹提示，这里只为了收窄类型
			if (message.kind === "blank") return;
			if (message.kind === "exit") {
				setPicking(false);
				return;
			}
			if (message.kind === "note") {
				// 页面上就地写完的那一条：地址先换回原网址（不然记下的是 /web/p/… 那串内部路径）
				record(message.note);
				return;
			}
			// 旧脚本只报「选中了哪儿」、不带评论：当成一条没有评论的注释，不至于丢了
			record({ ...message.pick, comment: "" });
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [pushMarks, record, send]);

	const go = (raw: string) => {
		const url = normalizeUrl(raw);
		if (!url) {
			setError(t("这不像是个网址（只支持 http / https）", "That does not look like a URL (http / https only)"));
			return;
		}
		setError(null);
		setDraft(url);
		setHistory((items) => [...items.slice(0, index + 1), url]);
		setIndex((value) => value + 1);
	};

	const togglePick = () => {
		if (picking) {
			send({ type: "off" });
			setPicking(false);
			return;
		}
		send({ type: "on" });
		setPicking(true);
	};

	return (
		<div className="work-web" ref={zoom.ref} {...zoom.pointerHandlers}>
			<div className="work-web-bar">
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => setIndex((value) => Math.max(0, value - 1))}
					disabled={index <= 0}
					title={t("后退", "Back")}
				>
					←
				</button>
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => setIndex((value) => Math.min(history.length - 1, value + 1))}
					disabled={index >= history.length - 1}
					title={t("前进", "Forward")}
				>
					→
				</button>
				{/* 标注紧跟在后退 / 前进右边（用户要求）：它和「刷新 / 后退」一样是「对这一页做什么」 */}
				{canNote ? (
					<button
						type="button"
						className={`btn btn-tiny work-web-pick${picking ? " work-web-pick-on" : ""}`}
						onClick={togglePick}
						disabled={!current}
						aria-pressed={picking}
						title={
							picking
								? t("退出标注", "Stop annotating")
								: t(
										"标注网页：点页面上要改的那一处，收进输入框那颗「N 条注释」",
										"Annotate the page: click the spot to change; it joins the notes in the input",
									)
						}
					>
						📍{marksHere.length > 0 ? ` ${marksHere.length}` : ""}
					</button>
				) : null}
				{/*
				 * 手机尺寸预览：一颗按钮，点开是菜单（关闭 / 选机型）。机型不再占工具栏的宽度，网址框拿回空间。
				 */}
				<div className="work-web-phone-wrap" ref={phoneMenuRef}>
					<button
						type="button"
						className={`btn btn-tiny work-web-phone-btn${phone ? " work-web-phone-on" : ""}`}
						onClick={() => setPhoneMenuOpen((open) => !open)}
						aria-pressed={phone}
						aria-haspopup="menu"
						aria-expanded={phoneMenuOpen}
						title={
							phone
								? t(
										`手机预览：${preset.label}（点开换机型或关闭）`,
										`Phone preview: ${preset.label} (open to change or turn off)`,
									)
								: t("手机尺寸预览：点开选机型", "Phone-size preview: open to pick a device")
						}
					>
						📱
					</button>
					{phoneMenuOpen ? (
						<div className="work-web-phone-menu" role="menu">
							<button
								type="button"
								role="menuitem"
								className={`work-web-phone-item${phone ? "" : " work-web-phone-item-on"}`}
								onClick={() => {
									setPhone(false);
									setPhoneMenuOpen(false);
								}}
							>
								{t("关闭手机预览", "Turn off the phone preview")}
							</button>
							{PHONE_PRESETS.map((item) => (
								<button
									key={item.id}
									type="button"
									role="menuitem"
									className={`work-web-phone-item${phone && item.id === preset.id ? " work-web-phone-item-on" : ""}`}
									onClick={() => {
										setPhoneSize(item.id);
										writeStored(WEB_PHONE_SIZE_KEY, item.id);
										setPhone(true);
										setPhoneMenuOpen(false);
									}}
								>
									{item.label}
								</button>
							))}
						</div>
					) : null}
				</div>
				{/* 标过的位置会一直留着（连浏览器重启都在）：得给人一个清干净的口子 */}
				{canNote && current && marksHere.length > 0 ? (
					<button
						type="button"
						className="btn btn-tiny"
						onClick={clearMarks}
						title={t(`清空这一页的 ${marksHere.length} 处标记`, `Clear the ${marksHere.length} mark(s) on this page`)}
						aria-label={t("清空这一页的标记", "Clear the marks on this page")}
					>
						⌫
					</button>
				) : null}
				<input
					className="work-web-input"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.nativeEvent.isComposing) go(draft);
					}}
					placeholder={t("输入网址后回车（例：localhost:3000）", "Type a URL and press Enter (e.g. localhost:3000)")}
					spellCheck={false}
				/>
				{/* 刷新紧跟在网址输入框右边（用户要求）：刷新 = 这一页从头来，标记跟着清空 */}
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => {
						// 刷新 = 这一页从头来：标记跟着清空（⌫ 那颗做的也是这件事，只是不用再点一次）
						if (canNote && current && marksHere.length > 0) clearMarks();
						setReloadSeq((value) => value + 1);
					}}
					disabled={!current}
					title={t("刷新（同时清空这一页的标记）", "Reload (also clears the marks on this page)")}
				>
					↻
				</button>
				{current ? (
					<a
						className="btn btn-tiny"
						href={current}
						target="_blank"
						rel="noopener noreferrer"
						title={t("在系统浏览器打开")}
					>
						⧉
					</a>
				) : null}
			</div>
			{error ? <div className="work-web-note work-web-note-error">{error}</div> : null}
			{picking ? (
				<div className="work-web-note work-web-pick-hint">
					{t(
						"点页面上要改的那一处，就地写一句；可以接着标多处（Esc 退出）",
						"Click the spot to change and type right there; keep going for more (Esc to stop)",
					)}
				</div>
			) : null}
			{current ? (
				/**
				 * `work-web-stage` 是「装页面那一块」：平时就是整块，手机预览时是居中的画布。
				 * 缩放分两层：面板缩放（⌘/Ctrl ±，`zoom.percent`）× 机身自适应（放不下整台手机时
				 * 等比缩小，`phoneScale`）。两层相乘，所以手机预览里也能临时放大看清楚。
				 */
				<div className={`work-web-stage${phone ? " work-web-stage-phone" : ""}`} ref={stageRef}>
					<div
						className={`work-web-body${phone ? " work-web-body-phone" : ""}`}
						style={
							phone
								? {
										width: `${preset.width}px`,
										height: `${preset.height}px`,
										zoom: (phoneScale * zoom.percent) / 100,
									}
								: { zoom: zoom.percent / 100 }
						}
					>
						<iframe
							// 走本机代理（ADR-0047）：百度 / GitHub 这类站点的 X-Frame-Options 拦不住它。
							// 代理取不到（非 http(s)、代理本身报错）时退回直连 —— 至少能嵌的站点还能看
							// 换手机/电脑模式要整页重载：这一版是**服务端按 UA 发的**，改宽度没用
							key={`${current}#${reloadSeq}#${phone ? "m" : "d"}`}
							ref={frameRef}
							className="work-web-frame"
							src={frameSrc}
							title={current}
							// 不设 allow-top-navigation：嵌进来的站点不能把整个工作台导走。
							// 权限集见 SANDBOX_OPAQUE / SANDBOX_SAME_ORIGIN 上那段：有同源外壳时才能给
							// `allow-same-origin`，而且那个「同源」是同外壳同源、与工作台不是同一个源。
							sandbox={frameSandbox}
							referrerPolicy="no-referrer"
						/>
					</div>
				</div>
			) : (
				<div className="work-web-start">
					<p className="side-panel-hint">
						{t(
							"输入网址就能在这儿打开（经本机代理，拒绝被嵌入的站点也能显示）",
							"Enter a URL to open it here (served through the local proxy, so sites that refuse embedding still work)",
						)}
					</p>
					<p className="side-panel-hint work-web-caveat">
						{t(
							"代理不带 cookie、跑在隔离沙箱里：要重登录的站点（GitHub、后台系统）可能是一片空白；面板里跑不起来的页面会提示你『在新窗口打开』。",
							"The proxy carries no cookies and runs in an isolated sandbox: sites that need a session (GitHub, admin consoles) may stay blank, and pages that cannot run in a panel will offer “Open in a window”.",
						)}
					</p>
					<div className="work-web-suggestions">
						{SUGGESTIONS.map((url) => (
							<button type="button" className="tpl-card" key={url} onClick={() => go(url)}>
								<span className="tpl-card-title">{url.replace(/^https?:\/\//, "")}</span>
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
