import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { connect } from "./ws.ts";
import { watchMobileShell } from "./mobile-shell-dom.ts";
import "./styles.css";

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
