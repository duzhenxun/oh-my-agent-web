import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 前端构建/开发配置（ADR-0007：开发态 vite 5174，反代到后端 8791）。
 * root 显式设为 web/：脚本从仓库根用 `--config web/vite.config.ts` 调用，cwd 是仓库根。
 * fs.allow 需要放开仓库根：`web/src/types.ts` 是 `server/protocol.ts` 的 shim（跨目录导入协议单源）。
 */
export default defineConfig({
	root: "web",
	plugins: [react()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		port: 5174,
		strictPort: true,
		fs: { allow: [".."] },
		proxy: {
			"/api": { target: "http://127.0.0.1:8791" },
			"/ws": { target: "ws://127.0.0.1:8791", ws: true },
		},
	},
});
