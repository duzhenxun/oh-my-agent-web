import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { connect } from "./ws.ts";
import { initTheme } from "./theme.ts";
import { initChatDisplay } from "./chat-display.ts";
import { initSidebarFonts } from "./sidebar-font.ts";
import { initAppbarScale } from "./appbar-scale.ts";
import { watchMobileShell } from "./mobile-shell-dom.ts";
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

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 容器");

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

connect();
