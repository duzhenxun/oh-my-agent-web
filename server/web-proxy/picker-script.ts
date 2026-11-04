/**
 * ADR-0047 的第三件事：**让用户能在右侧面板的网页里「指出哪儿要改」，并且就地写一句**。
 *
 * 为什么必须在页面**里面**跑代码：iframe 是 `sandbox` 且不带 `allow-same-origin`
 * （见 `web/src/components/WebTool.tsx` 里那段注释 —— 代理把别人的页面发在我们的源上，
 * 再给 same-origin 就等于把 localStorage / 会话 cookie 全交给远端 JS）。没有同源，
 * 父窗口连 `iframe.contentDocument` 都拿不到，**不可能**在外面算出「鼠标底下是哪个元素」，
 * 也就没法把输入框贴在那一块旁边 —— 所以编辑框只能由这段脚本自己画在页面里。
 *
 * 协议（两个方向都带 `__aw: "picker"` 作标记，父窗口还要校验 `event.source`）：
 *   父 → 页：`{type:"on"}` 进入拾取 / `{type:"off"}` 退出（连编辑框一起关）
 *            `{type:"cancel"}` 只关掉编辑框 / `{type:"marks", list:[{selector,number,comment}]}` 重画编号框
 *   页 → 父：`{type:"ready", url}` 文档就绪
 *            `{type:"note", url, selector, tag, label, text, comment}` 用户在页面上写完了一条
 *            `{type:"exit"}` 用户按了 Esc / 自己退出了拾取
 *
 * 几条要守住的：
 *   - 点一下就弹编辑框，**确认之后继续拾取** —— 一次能连着标好几处（用户明确要的）；
 *   - 再点另一处 = 把这个框挪过去，不是叠第二个框；
 *   - 编辑框自己那一块要 `pointer-events: auto`，其余图层全关，否则页面接不到鼠标事件；
 *   - 输入时的键盘事件一律 `stopPropagation`：页面自己的快捷键（`/`、`j`、`Esc`）不该被触发；
 *   - 只做到「页面自己说了算」：贴进来的站点脚本同样能往父窗口发这种消息（它就是那个 window），
 *     所以父窗口那一侧不信内容 —— 收到就只是一条待确认的注释，用户随时能删。
 */

/** 图层用 inline style：外来页面没有我们的 CSS，改它的样式表只会打架 */
export const PICKER_SCRIPT = `<script>(function(){
if (window.__awPicker) return;
window.__awPicker = true;

var PARENT = window.parent;
var Z = 2147483000;
var picking = false;
var hovered = null;
var hoveredSelector = "";
var pendingEl = null;
var marks = [];
var root = null;
var boxEl = null;
var tipEl = null;
var markNodes = [];
var editor = null;

function post(message){
  message.__aw = "picker";
  try { PARENT.postMessage(message, "*"); } catch (error) {}
}

/* ---- 图层（整块 fixed 覆盖，pointer-events 全关：不能挡住页面自己的鼠标事件） ---- */
function layer(){
  if (root && root.isConnected) return root;
  root = document.createElement("div");
  root.setAttribute("data-aw-picker", "1");
  root.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;z-index:" + Z + ";pointer-events:none;";
  (document.body || document.documentElement).appendChild(root);
  return root;
}

function ensureBox(){
  if (boxEl && boxEl.isConnected) return boxEl;
  boxEl = document.createElement("div");
  boxEl.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;box-sizing:border-box;border-radius:4px;pointer-events:none;";
  layer().appendChild(boxEl);
  return boxEl;
}

function ensureTip(){
  if (tipEl && tipEl.isConnected) return tipEl;
  tipEl = document.createElement("div");
  tipEl.style.cssText = "position:fixed;left:0;top:0;max-width:78%;padding:2px 6px;border-radius:4px;background:#1f6feb;color:#fff;font:11px/1.6 -apple-system,system-ui,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;";
  layer().appendChild(tipEl);
  return tipEl;
}

function hideBox(){
  if (boxEl) boxEl.style.display = "none";
  if (tipEl) tipEl.style.display = "none";
}

/* ---- 选择器：从元素往上拼，遇到「唯一的 id」就停 ---- */
function escapeIdent(value){
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, function(ch){ return "\\\\" + ch; });
}

function cssPath(element){
  var parts = [];
  var node = element;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    var tag = node.tagName.toLowerCase();
    if (node.id) {
      var idSelector = "#" + escapeIdent(node.id);
      try {
        if (document.querySelectorAll(idSelector).length === 1) {
          parts.unshift(idSelector);
          break;
        }
      } catch (error) {}
    }
    var part = tag;
    if (node.classList && node.classList.length > 0) part += "." + escapeIdent(node.classList[0]);
    var parent = node.parentElement;
    if (parent) {
      var same = 0;
      var mine = 0;
      for (var index = 0; index < parent.children.length; index += 1) {
        var child = parent.children[index];
        if (child.tagName === node.tagName) {
          same += 1;
          if (child === node) mine = same;
        }
      }
      if (same > 1) part += ":nth-of-type(" + mine + ")";
    }
    parts.unshift(part);
    node = parent;
    /* 六段足够定位，再往上就是整页的骨架，写进备注里只会更难读 */
    if (parts.length >= 6) break;
  }
  /* 点到 html / body 这种最外层时上面一段都没拼：退回标签名，总比空串好 */
  if (parts.length === 0) return element.tagName ? element.tagName.toLowerCase() : "";
  return parts.join(" > ");
}

/* ---- 人看得懂的那点提示：可见文字 / 占位符 / alt ---- */
function clip(text){
  var flat = String(text || "").replace(/\\s+/g, " ").trim();
  return flat.length > 60 ? flat.slice(0, 60) + "…" : flat;
}

function labelOf(element){
  var attrs = ["aria-label", "placeholder", "alt", "title", "name", "type"];
  for (var index = 0; index < attrs.length; index += 1) {
    var value = element.getAttribute && element.getAttribute(attrs[index]);
    if (value) return clip(value);
  }
  return "";
}

function snippetOf(element){
  /*
   * 量之前先把我们自己的图层藏起来：编号框的「1」与编辑框里的字也在 DOM 里，
   * 不藏的话 innerText 会把它们一起抓进「元素文字」，写进备注就成了噪声。
   * 同一个任务里藏了马上还原，页面不会看到闪一下。
   */
  var hidden = false;
  if (root && root.isConnected && root.style.display !== "none") {
    root.style.display = "none";
    hidden = true;
  }
  var text = element.innerText === undefined ? element.textContent : element.innerText;
  if (hidden) root.style.display = "";
  return clip(text);
}

/* ---- 画：待确认的框 + 已标注的框/编号 ---- */
function paint(){
  var target = pendingEl || hovered;
  if (!target || !target.isConnected) {
    hideBox();
    positionMarks();
    return;
  }
  var rect = target.getBoundingClientRect();
  var box = ensureBox();
  box.style.display = "block";
  box.style.left = rect.left + "px";
  box.style.top = rect.top + "px";
  box.style.width = Math.max(rect.width, 1) + "px";
  box.style.height = Math.max(rect.height, 1) + "px";
  box.style.border = pendingEl ? "2px dashed #f0883e" : "2px solid #1f6feb";
  box.style.background = pendingEl ? "rgba(240,136,62,0.12)" : "rgba(31,111,235,0.12)";
  var tip = ensureTip();
  /* 编辑框开着的时候不再用那行小提示：框里已经写着选择器了，两条一起出现只会打架 */
  if (editor) {
    tip.style.display = "none";
  } else {
    tip.style.display = "block";
    tip.textContent = pendingEl ? "已选中：" + (hoveredSelector || "") : (hoveredSelector || "");
    var tipTop = rect.top > 20 ? rect.top - 20 : rect.top + 2;
    tip.style.left = Math.max(0, rect.left) + "px";
    tip.style.top = Math.max(0, tipTop) + "px";
  }
  positionMarks();
  placeEditor();
}

function positionMarks(){
  for (var index = 0; index < markNodes.length; index += 1) {
    var node = markNodes[index];
    var mark = marks[index] || {};
    var element = null;
    try { element = mark.selector ? document.querySelector(mark.selector) : null; } catch (error) { element = null; }
    if (!element) { node.style.display = "none"; continue; }
    var rect = element.getBoundingClientRect();
    node.style.display = "block";
    node.style.left = rect.left + "px";
    node.style.top = rect.top + "px";
    node.style.width = Math.max(rect.width, 1) + "px";
    node.style.height = Math.max(rect.height, 1) + "px";
  }
}

function renderMarks(){
  var host = layer();
  for (var index = 0; index < markNodes.length; index += 1) {
    var old = markNodes[index];
    if (old.parentNode) old.parentNode.removeChild(old);
  }
  markNodes = [];
  for (var at = 0; at < marks.length; at += 1) {
    var mark = marks[at] || {};
    var wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;left:0;top:0;box-sizing:border-box;border:2px dashed #f0883e;border-radius:4px;background:rgba(240,136,62,0.08);pointer-events:none;";
    var badge = document.createElement("div");
    badge.style.cssText = "position:absolute;left:-8px;top:-8px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#f0883e;color:#fff;font:bold 11px/16px -apple-system,system-ui,sans-serif;text-align:center;box-sizing:border-box;";
    badge.textContent = String(mark.number || at + 1);
    if (mark.comment) badge.title = String(mark.comment);
    wrap.appendChild(badge);
    host.appendChild(wrap);
    markNodes.push(wrap);
  }
  positionMarks();
}

/* ---- 就地编辑框：贴着被点中的那一块 ---- */
function commentOf(selector){
  for (var index = 0; index < marks.length; index += 1) {
    var mark = marks[index] || {};
    if (mark.selector === selector && mark.comment) return String(mark.comment);
  }
  return "";
}

function closeEditor(){
  if (!editor) return;
  if (editor.parentNode) editor.parentNode.removeChild(editor);
  editor = null;
}

function openEditor(element, selector){
  closeEditor();
  var host = layer();
  var wrap = document.createElement("div");
  wrap.setAttribute("data-aw-editor", "1");
  wrap.style.cssText = "position:fixed;left:8px;top:8px;width:280px;max-width:calc(100vw - 16px);box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #1f6feb;background:#fff;color:#111;box-shadow:0 8px 24px rgba(0,0,0,0.24);font:12px/1.5 -apple-system,system-ui,'Segoe UI',sans-serif;pointer-events:auto;";

  var head = document.createElement("div");
  head.style.cssText = "font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#57606a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  head.textContent = selector;
  head.title = selector;

  var input = document.createElement("input");
  input.type = "text";
  input.value = commentOf(selector);
  input.placeholder = "这一处要改成什么？（可留空，只标位置）";
  input.style.cssText = "display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:4px 6px;border:1px solid #d0d7de;border-radius:4px;font:12px/1.5 -apple-system,system-ui,'Segoe UI',sans-serif;color:#111;background:#fff;";

  var row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:6px;";

  var hint = document.createElement("span");
  hint.style.cssText = "flex:1 1 auto;font:11px/1.4 -apple-system,system-ui,sans-serif;color:#8c959f;";
  hint.textContent = "Enter 添加 · Esc 取消";

  var ok = document.createElement("button");
  ok.type = "button";
  ok.textContent = "添加";
  ok.style.cssText = "flex:none;padding:3px 10px;border:none;border-radius:4px;background:#1f6feb;color:#fff;font:12px/1.5 -apple-system,system-ui,sans-serif;cursor:pointer;";

  var cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "✕";
  cancel.title = "取消这一条";
  cancel.style.cssText = "flex:none;padding:3px 8px;border:1px solid #d0d7de;border-radius:4px;background:#f6f8fa;color:#57606a;font:12px/1.5 -apple-system,system-ui,sans-serif;cursor:pointer;";

  function stop(event){ event.stopPropagation(); }
  /*
   * 键盘一律在捕获阶段拦：页面自己的快捷键（斜杠、j、Esc）不该被我们打的字触发。
   *
   * 鼠标**不能**在捕获阶段拦 —— 那样事件到不了「添加 / ✕」两颗按钮本身（capture 阶段调
   * stopPropagation，目标节点的监听器就不会跑了，表现就是「点添加没反应」）。
   * 改成冒泡阶段拦：按钮先处理完，再把事件挡在我们这层，页面收不到。
   */
  wrap.addEventListener("keydown", function(event){
    event.stopPropagation();
    if (event.key === "Enter") { event.preventDefault(); submit(); }
    else if (event.key === "Escape") { event.preventDefault(); cancelEdit(); }
  }, true);
  wrap.addEventListener("keyup", stop, true);
  wrap.addEventListener("keypress", stop, true);
  wrap.addEventListener("mousedown", stop, false);
  wrap.addEventListener("click", stop, false);
  wrap.addEventListener("pointerdown", stop, false);

  function submit(){
    post({
      type: "note",
      url: String(location.href || ""),
      selector: selector,
      tag: element.tagName.toLowerCase(),
      label: labelOf(element),
      text: snippetOf(element),
      comment: String(input.value || "").trim()
    });
    closeEditor();
    pendingEl = null;
    hideBox();
    positionMarks();
    /* **继续拾取**：一次可以连着标好几处，要停就 Esc 或再点那颗 📍 */
    if (picking) document.documentElement.style.cursor = "crosshair";
  }

  function cancelEdit(){
    closeEditor();
    pendingEl = null;
    hideBox();
    positionMarks();
  }

  ok.addEventListener("click", function(event){ event.preventDefault(); event.stopPropagation(); submit(); });
  cancel.addEventListener("click", function(event){ event.preventDefault(); event.stopPropagation(); cancelEdit(); });

  row.appendChild(hint);
  row.appendChild(ok);
  row.appendChild(cancel);
  wrap.appendChild(head);
  wrap.appendChild(input);
  wrap.appendChild(row);
  host.appendChild(wrap);
  editor = wrap;
  placeEditor();
  /* 页面可能自己在 load / click 里抢焦点：下一拍再拿一次 */
  window.setTimeout(function(){ try { input.focus(); } catch (error) {} }, 0);
}

/** 贴着元素放：下面放不下就翻到上面，左右夹在视口里 */
function placeEditor(){
  if (!editor || !pendingEl || !pendingEl.isConnected) return;
  var rect = pendingEl.getBoundingClientRect();
  var width = editor.offsetWidth || 280;
  var height = editor.offsetHeight || 100;
  var gap = 8;
  var top = rect.bottom + gap;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - gap - height);
  var left = rect.left;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
  editor.style.left = Math.max(8, left) + "px";
  editor.style.top = top + "px";
}

/* ---- 拾取 ---- */
function onMove(event){
  if (!picking || editor) return;
  var element = event.target;
  if (!element || element.nodeType !== 1) return;
  if (root && root.contains(element)) return;
  if (element === hovered) return;
  hovered = element;
  try { hoveredSelector = cssPath(element); } catch (error) { hoveredSelector = element.tagName ? element.tagName.toLowerCase() : ""; }
  paint();
}

function onClick(event){
  if (!picking) return;
  var element = event.target;
  if (!element || element.nodeType !== 1) return;
  /* 编辑框 / 编号框上的点击是给我们自己的，不能当成「又选了别处」 */
  if (root && root.contains(element)) return;
  /* 拾取时点上就是「选它」，不能让链接把页面导走、也不能让站点自己的点击逻辑插手 */
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  pendingEl = element;
  hovered = null;
  try { hoveredSelector = cssPath(element); } catch (error) { hoveredSelector = element.tagName.toLowerCase(); }
  paint();
  openEditor(element, hoveredSelector);
  paint();
}

function onKeyDown(event){
  if (event.key !== "Escape") return;
  /* 编辑框里按 Esc = 只取消这一条（那一份监听自己会处理），不要把整个标注模式关掉 */
  if (editor && editor.contains(event.target)) return;
  event.preventDefault();
  stopPicking(true);
}

/* 中键 / 侧键点链接会开新标签：拾取时一律吞掉，不然「只是在选这一块」却弹出好几个页面 */
function onAuxClick(event){
  if (!picking) return;
  event.preventDefault();
  event.stopPropagation();
}

function onDragStart(event){
  if (!picking) return;
  event.preventDefault();
}

/**
 * 监听挂在 **window** 的捕获阶段，不是 document。
 *
 * 为什么：代理注入的「点击跳转」脚本（rewrite.ts 里的 NAV_SCRIPT）挂在 document 捕获上，
 * 而它比这段脚本先注册 —— 同一层上谁都抢不过它，点链接时页面就被它导走了，
 * 「标注时点链接不该跳转」根本做不到。window 捕获在整条传播路径的最前面，
 * 这里一拦，下面（包括那个跳转脚本、页面自己的点击逻辑）就都收不到了。
 * 另外还立了个 window.__awPicking 标记：那边看到它就主动让路（双保险）。
 */
function startPicking(){
  if (picking) return;
  picking = true;
  window.__awPicking = true;
  hovered = null;
  hoveredSelector = "";
  document.documentElement.style.cursor = "crosshair";
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("auxclick", onAuxClick, true);
  window.addEventListener("dragstart", onDragStart, true);
  window.addEventListener("keydown", onKeyDown, true);
}

function stopPicking(notify){
  closeEditor();
  pendingEl = null;
  if (picking) {
    picking = false;
    window.__awPicking = false;
    document.documentElement.style.cursor = "";
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("auxclick", onAuxClick, true);
    window.removeEventListener("dragstart", onDragStart, true);
    window.removeEventListener("keydown", onKeyDown, true);
  }
  hovered = null;
  hideBox();
  positionMarks();
  if (notify) post({ type: "exit" });
}

/* ---- 与父窗口说话 ---- */
window.addEventListener("message", function(event){
  if (event.source !== PARENT) return;
  var data = event.data;
  if (!data || data.__aw !== "picker") return;
  if (data.type === "on") startPicking();
  else if (data.type === "off") stopPicking(false);
  else if (data.type === "cancel") {
    closeEditor();
    pendingEl = null;
    hideBox();
    positionMarks();
  } else if (data.type === "marks") {
    marks = data.list && data.list.length ? data.list : [];
    renderMarks();
    placeEditor();
  }
}, false);

document.addEventListener("scroll", paint, true);
window.addEventListener("resize", paint);
window.addEventListener("load", paint);

function ready(){
  paint();
  post({ type: "ready", url: String(location.href || "") });
  /*
   * 「这页其实没渲染出来」：给面板一个信号，让它把 ⧉ 推到人眼前。
   *
   * 为什么需要：有的页面（带 WebView 桥、启动时读 window.top.xxx 的）在「自己是子框架」
   * 时会直接抛错，Vue / React 根节点根本没挂上，屏幕上只剩它自己的底色 —— 看着就是「黑屏」，
   * 而面板这一侧不透明源里什么也拿不到（连 DOM 都读不到），只能靠页面自己报。
   * 判据取保守一点：正文一个字都没有，且没有一屏看得见的图 / 画布 / 视频。宁可漏报，不乱报。
   */
  window.setTimeout(function(){
    try { if (looksBlank()) post({ type: "blank", url: String(location.href || "") }); } catch (error) {}
  }, 2500);
}

function looksBlank(){
  var text = document.body && document.body.innerText ? document.body.innerText : "";
  if (String(text).replace(/\\s+/g, "") !== "") return false;
  var nodes = document.querySelectorAll("img, canvas, video, svg, iframe");
  for (var index = 0; index < nodes.length; index += 1) {
    var rect = nodes[index].getBoundingClientRect();
    if (rect.width > 40 && rect.height > 40) return false;
  }
  return true;
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, false);
else ready();
})()</script>`;
