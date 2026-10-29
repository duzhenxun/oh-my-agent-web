/**
 * ADR-0047：代理回来的文档要做两件事 —— 把「根相对」地址改写进代理前缀、拦下页面内的跳转。
 *
 * 为什么只改根相对的：地址形状是镜像路径（见 proxy-url.ts），相对地址浏览器自己会算对；
 * 绝对地址（CDN、其它站）直连更省事也更快。真正会跑偏的只有以 `/` 开头的那些，
 * 以及 `//cdn.example/x.js` 这种协议相对的（我们这边可能是 http，直接会 404）。
 *
 * 为什么不解析 DOM：这块只要能「把页面显示出来」，为此引一个 HTML 解析器不值得；
 * 正则只碰 `src / href / action / poster` 这几个属性与 CSS 的 `url()`，改坏了最多是某张图裂开，
 * 而不是整页空白。JS 里动态拼的地址改不到 —— 那类走点击拦截（`NAV_SCRIPT`）兜底。
 */

type RewriteScope = { scheme: string; host: string };

const PREFIX_OF = (scope: RewriteScope) => `/web/p/${scope.scheme}/${scope.host}`;

/** 单个引用值要不要改写。返回原值表示「不动」 */
function toProxied(value: string, scope: RewriteScope): string {
	const trimmed = value.trim();
	if (!trimmed) return value;
	const prefix = PREFIX_OF(scope);
	if (trimmed.startsWith(prefix)) return value; // 已经是代理地址（二次注入 / 页面自己拼的）
	if (trimmed.startsWith("//")) return `${scope.scheme}:${trimmed}`; // 协议相对 → 补协议直连
	if (trimmed.startsWith("/")) return `${prefix}${trimmed}`; // 根相对 → 必须走代理
	// 绝对 `http(s)://`、`data:`、`javascript:`、`#锚点`、纯相对路径：一律原样
	return value;
}

const ATTR = /(\s(?:src|href|action|poster|data-src|data-href)\s*=\s*)(["'])([^"']*)\2/gi;

/**
 * 页面里所有页内跳转都改成走代理。
 *
 * 为什么不用 `<base>`：`<base>` 只能改相对地址的解析基准，改不了根相对与绝对地址；
 * 而站点自己拼的绝对链接（搜索结果、分页）也必须代理，否则一点就撞回他们的 DENY。
 * 这里在**捕获阶段**拦 click / submit，把目标换算成代理地址再交给浏览器。
 */
const NAV_SCRIPT = `<script>(function(){
var PREFIX=${JSON.stringify("/web/p/")};
function proxied(href){
  if(!href) return null;
  if(href.indexOf(PREFIX)===0) return href;
  var abs;
  try{ abs=new URL(href, location.href); }catch(e){ return null; }
  if(abs.protocol!=="http:"&&abs.protocol!=="https:") return null;
  return PREFIX+abs.protocol.slice(0,-1)+"/"+abs.host+abs.pathname+abs.search+abs.hash;
}
document.addEventListener("click",function(event){
  var node=event.target;
  while(node&&node.nodeType===1&&node.tagName!=="A") node=node.parentElement;
  if(!node||node.tagName!=="A") return;
  if(node.target&&node.target!=="_self") return;
  if(event.metaKey||event.ctrlKey||event.shiftKey||event.button!==0) return;
  var next=proxied(node.getAttribute("href"));
  if(!next) return;
  event.preventDefault();
  location.href=next;
},true);
document.addEventListener("submit",function(event){
  var form=event.target;
  if(!form||form.tagName!=="FORM") return;
  var next=proxied(form.getAttribute("action")||location.href);
  if(next) form.setAttribute("action",next);
},true);
})()</script>`;

/** HTML：属性改写 + 把拦截脚本塞进 `<head>`（没有 head 就塞在文档最前面） */
export function rewriteHtml(html: string, scope: RewriteScope): string {
	const rewritten = html.replace(ATTR, (whole, lead: string, quote: string, value: string) => {
		const next = toProxied(value, scope);
		return next === value ? whole : `${lead}${quote}${next}${quote}`;
	});
	const head = /<head[^>]*>/i.exec(rewritten);
	if (head && head.index >= 0) {
		const at = head.index + head[0].length;
		return `${rewritten.slice(0, at)}${NAV_SCRIPT}${rewritten.slice(at)}`;
	}
	return NAV_SCRIPT + rewritten;
}

const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

/** CSS：只改 `url()` 里的根相对 / 协议相对（背景图、字体） */
export function rewriteCss(css: string, scope: RewriteScope): string {
	return css.replace(CSS_URL, (whole, quote: string, value: string) => {
		const next = toProxied(value, scope);
		return next === value ? whole : `url(${quote}${next}${quote})`;
	});
}
