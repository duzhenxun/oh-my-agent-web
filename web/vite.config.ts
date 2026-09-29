import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Dev has one entry point: `npm run dev` (OWA_DEV_WEB=1) runs the backend on
// :25257 and mounts this config's Vite instance **in-process** as middleware, so
// there is no second port. The plain `vite` CLI mode (`npm run dev:web`) only
// exists for the scripted mock backend in web/dev-mock-server.mjs, which cannot
// host middlewares itself and therefore relies on the /ws + /api proxy below.
export default defineConfig({
	root: __dirname,
	plugins: [react()],
	resolve: {
		alias: {
			"@shared": join(repoRoot, "shared"),
			"@": join(__dirname, "src"),
		},
	},
	server: {
		// 默认 host 是 `localhost`，在本机只解析到 ::1，会绑成 [::1]；显式绑 IPv4，
		// 免得直连 http://127.0.0.1 的客户端（以及 dev-mock 那套）连不上。
		host: "127.0.0.1",
		fs: { allow: [repoRoot] },
		proxy: {
			"/api": "http://127.0.0.1:25257",
			"/ws": {
				target: "ws://127.0.0.1:25257",
				ws: true,
				configure(proxy) {
					proxy.on("error", (_err, _req, socket) => {
						(socket as { destroy?: () => void } | undefined)?.destroy?.();
					});
					proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
						socket.on("error", () => {});
					});
				},
			},
		},
	},
	build: {
		outDir: join(__dirname, "dist"),
		emptyOutDir: true,
		target: "es2022",
		rollupOptions: {
			output: {
				// Keep the heavy markdown/highlight payload in its own chunk so app
				// code changes don't force a re-download of ~600 kB.
				manualChunks: {
					markdown: ["react-markdown", "remark-gfm", "rehype-highlight", "highlight.js"],
				},
			},
		},
	},
});
