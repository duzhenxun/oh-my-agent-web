/**
 * 右侧分栏里的「网页」页：地址栏 + iframe。
 *
 * 为什么是 iframe：本地服务不设 `X-Frame-Options` / `frame-ancestors`，直接嵌最省事，
 * 也不需要（更不该）为此开一个能代理任意站点的后端（那是 SSRF 的口子）。
 * 代价写在界面上：**对方站点自己拒绝被嵌**时（GitHub、Google 之类），面板里会是空白，
 * 这时点「在浏览器打开」跳出去 —— 不假装我们能做到任意网页都能嵌。
 */
import { useRef, useState } from "react";
import { normalizeUrl, proxyUrlOf } from "../url-bar.ts";
import { useT } from "../use-language.ts";
import { usePanelZoom } from "../panel-zoom.ts";
import { WEB_ZOOM_KEY } from "../ui-prefs.ts";

const SUGGESTIONS = ["http://localhost:3000", "https://www.baidu.com", "https://developer.mozilla.org"];

export function WebTool({ initialUrl = "" }: { initialUrl?: string }) {
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

	const current = index >= 0 ? history[index] : "";

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
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => setReloadSeq((value) => value + 1)}
					disabled={!current}
					title={t("刷新", "Reload")}
				>
					↻
				</button>
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
				<button type="button" className="btn btn-tiny" onClick={() => go(draft)} title={t("打开", "Open")}>
					{t("打开", "Open")}
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
			{current ? (
				<iframe
					// 走本机代理（ADR-0047）：百度 / GitHub 这类站点的 X-Frame-Options 拦不住它。
					// 代理取不到（非 http(s)、代理本身报错）时退回直连 —— 至少能嵌的站点还能看
					key={`${current}#${reloadSeq}`}
					ref={frameRef}
					className="work-web-frame"
					style={{ zoom: zoom.percent / 100 }}
					src={proxyUrlOf(current) ?? current}
					title={current}
					// 不设 allow-top-navigation：嵌进来的站点不能把整个工作台导走。
					// **不能**给 allow-same-origin：代理把别人的页面发在**我们自己的源**上，
					// 再允许 same-origin 就等于把 localStorage / 会话 cookie / RPC 全都交给远端 JS
					// （沙箱里没有 same-origin 时文档是不透明源，页面自己的 cookie 也不要了）
					sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
					referrerPolicy="no-referrer"
				/>
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
							"代理不带 cookie、跑在孤立沙箱里：重登录 / 重脚本的站点（GitHub、后台系统）可能是一片空白，那就点 ⧉ 用系统浏览器打开。",
							"The proxy carries no cookies and runs in an isolated sandbox: sites that need a session or heavy JS (GitHub, admin consoles) may stay blank — use ⧉ then.",
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
