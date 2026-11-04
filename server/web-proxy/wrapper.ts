/**
 * ADR-0047 的补充：**同源外壳**（`/web/w?u=<原网址>`）。
 *
 * 要解决的是一个具体故障：有些页面（映客的 banner 活动页就是）在启动阶段要读
 * `document.cookie` 和 `window.parent.<桥属性>`。面板里的 iframe 是 `sandbox` 且**不带**
 * `allow-same-origin` —— 那是个不透明源，两样都直接抛 SecurityError，页面还没挂载就死了，
 * 只剩它自己的深色底（用户看到的就是「打开一个网页是黑屏」）。
 *
 * 那条 `allow-same-origin` 不敢直接加：代理把别人的页面发在**我们自己的源**上，
 * 给了它就等于把工作台的 localStorage / 会话 cookie / RPC 交给远端 JS。
 *
 * 所以插一层壳：
 *
 *     工作台 (http://127.0.0.1:port)          ← 我们的源，页面碰不到
 *       └─ 外壳 (http://localhost:port/web/w)  ← 这一层是「兄弟回环主机」，与页面同源
 *            └─ 页面 (/web/p/https/…)          ← 真实源是外壳那个，它读 cookie / parent 都成立
 *
 * 三件事因此同时成立：
 *   1. 页面有一个**真实**的源（cookie / localStorage 不再抛错）；
 *   2. 那个源**不是**工作台的源（兄弟主机名，cookie 罐与 origin 都不同）——
 *      读不到工作台的存储，也调不到工作台的接口；
 *   3. 页面读 `window.parent` 拿到的就是同一个源的外壳，不再抛错。
 *
 * 外壳还要**中继消息**：页面里的拾取脚本（`picker-script.ts`）往 `window.parent` 发消息，
 * 现在那个 parent 是外壳而不是工作台 —— 不转一手，📍 标注就静悄悄地没反应了。
 * 两个方向都转，只转带 `__aw: "picker"` 标记的。
 *
 * 只在「本机回环访问」时启用（见 `web/src/url-bar.ts` 的 `wrapperUrlOf`）：远程访问没有兄弟
 * 回环主机可用，那时照旧走原来的沙箱（这类页面只能 ⧉ 打开）。
 */

/** 外壳路径。放在 `/web/` 下：它和代理是同一件事（让网页能在面板里跑），不掺进 API 路由 */
export const WRAPPER_PATH = "/web/w";

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => {
		const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
		return map[ch] ?? ch;
	});
}

/**
 * 外壳页面。`proxiedPath` 由调用方用 `proxyPathOf` 算好（原网址先校验过是 http(s)）。
 *
 * 顺序有讲究：中继脚本在 `<iframe>` **之前**就挂上监听 —— 页面（尤其缓存命中时）可能在
 * iframe 元素插进 DOM 后立刻发 `ready`，监听晚一步就丢了那一条，标签和编号框的恢复会慢一拍。
 */
export function wrapperHtml(proxiedPath: string, title: string): string {
	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
	html, body { margin: 0; height: 100%; background: #fff; }
	iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
<script>
(function () {
	var MARK = "picker";
	function post(target, message) {
		if (!target) return;
		try { target.postMessage(message, "*"); } catch (error) {}
	}
	/** 页面那一帧：按需取（监听先挂上，元素后到） */
	function inner() {
		var frame = document.getElementById("aw-page");
		return frame ? frame.contentWindow : null;
	}
	/*
	 * 两个方向：工作台 → 页面（命令）、页面 → 工作台（ready / note / exit）。
	 * 只转带标记的消息：这一层对两边都是同源（页面能读到外壳的 DOM），
	 * 所以不能因为「谁发的」就转发任何东西 —— 只认协议里的那条标记。
	 */
	window.addEventListener("message", function (event) {
		var data = event.data;
		if (!data || data.__aw !== MARK) return;
		/* 自己就是顶层（外壳被当页面开在新窗口里）：上面没人接，不要再往自己转（会回声） */
		if (window.parent === window) return;
		if (event.source === window.parent) {
			post(inner(), data); // 工作台 → 页面
			return;
		}
		if (event.source === inner()) post(window.parent, data); // 页面 → 工作台
	}, false);
})();
</script>
</head>
<body>
<iframe id="aw-page" src="${escapeHtml(proxiedPath)}"></iframe>
</body>
</html>`;
}
