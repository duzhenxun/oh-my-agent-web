import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { connect, startOnEmptyScreen, watchVisibility } from "./ws.ts";
import { sessionIdFromUrl } from "./session-url.ts";
import { initTheme } from "./theme.ts";
import { initChatDisplay } from "./chat-display.ts";
import { initSidebarFonts } from "./sidebar-font.ts";
import { initAppbarScale } from "./appbar-scale.ts";
import { applyDocumentLang, readLanguage } from "./language.ts";
import { watchMobileShell } from "./mobile-shell-dom.ts";
import { watchVisualViewport } from "./visual-viewport.ts";
import { loadEnTable } from "./use-language.ts";
import "./styles.css";

// 主题也挂在 <html> 上（data-theme / data-theme-mode）：**首帧前**必须生效，
// 否则深色主题会先白一下再变深。存储的读取和色板的定义都在 theme.ts。
initTheme();

// 聊天区字号 / 内容宽度（设置 → 外观）：同样是"首帧前就要对"的本机偏好，
// 晚一步生效会让正文先按默认字号排一遍再跳，读起来很跳。
initChatDisplay();

// 侧栏的项目名 / 会话名字号（同样在设置 → 外观）：也是首帧前就要对，
// 否则列表会先按默认字号排一遍再整体跳一格。
initSidebarFonts();

// 顶栏整体大小（设置 → 外观 → 顶栏高度）：同样首帧前就得生效，
// 否则顶栏会先按原尺寸排一遍、再把下面三栏往上抽一下。
initAppbarScale();

// 单栏/双栏的开关挂在 <html class="is-mobile-shell"> 上：首帧前先同步一次，
// 之后跟着窗口尺寸、方向变化刷新（手机 UA 即使在 900px 横屏也仍然是单栏）。
watchMobileShell();
// 键盘弹起时布局视口不变：把「真正看得见的那块」写进 --vvh / --vvtop，弹窗才不会被键盘盖住
watchVisualViewport();

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 容器");

const root = createRoot(container);
const boot = () =>
	root.render(
		<StrictMode>
			<App />
		</StrictMode>,
	);

// 语言：首次进入跟着浏览器的首选语言走（见 language.ts 的 `detectLanguage`）。
// 这里先把 `<html lang>` 对齐（index.html 里写死的是 zh-CN），
// 否则英文用户等词条表下载的那几百毫秒里，读屏/浏览器仍以为这是中文页。
applyDocumentLang(readLanguage());

// 英文词条表（`i18n-en.ts`，400+ 条 / 约 13KB）已经拆成按需 chunk：中文用户完全不下载。
// 代价是要在**首帧前**把它拿下来，否则英文用户会先看到一屏中文、再整页跳一遍 ——
// 这 13KB 的下载只让英文用户付，而且只有一次（后续走 chunk 缓存）。
// 加载失败不阻塞：loadEnTable 内部已经 catch，回落中文（见 use-language.ts）。
if (readLanguage() === "en") void loadEnTable().finally(boot);
else boot();

/**
 * 地址栏没带 `?session=`（就是直接进 `http://127.0.0.1:25257`）→ **这一屏从「新会话」开始**：
 * 不替人打开任何会话，也不恢复这个标签页上次看的那条（用户 2026-11-04 的要求）。
 * 带 `?session=`（书签 / 通知 / 「在新标签页打开」）照旧直达那条会话。
 */
if (sessionIdFromUrl(window.location.search) === null) startOnEmptyScreen();

connect();
// 后台标签页断掉 SSE、回前台重连：浏览器对同一地址只有 6 条连接，长期占满就会「切会话卡死」
watchVisibility();
