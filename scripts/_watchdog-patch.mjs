import { readFileSync, writeFileSync } from "node:fs";

const must = (cond, label) => {
	if (!cond) throw new Error(`miss: ${label}`);
};

// ---------- env.ts ----------
{
	const path = "server/util/env.ts";
	let s = readFileSync(path, "utf8");
	must(s.includes("\tengine: EngineName;"), "engine 字段");
	s = s.replace(
		"\tengine: EngineName;",
		"\tengine: EngineName;\n\t/** 回合看门狗超时（ADR-0023）：超时自动中断并提示 */\n\tturnTimeoutMs: number;",
	);
	must(s.includes("export const DEFAULT_PORT = 8790;"), "默认值区");
	s = s.replace(
		"export const DEFAULT_PORT = 8790;",
		"export const DEFAULT_PORT = 8790;\n/** 回合看门狗默认超时：20 分钟（与参考实现同口径） */\nexport const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1000;",
	);
	const engineDecl = `\tlet engine: EngineName = "pi";`;
	must(s.includes(engineDecl), "engine 解析");
	s = s.replace(
		engineDecl,
		`\tlet turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS;
	const rawTimeout = env.AGENT_WEB_TURN_TIMEOUT_MS;
	if (rawTimeout !== undefined && rawTimeout !== "") {
		const parsedTimeout = Number.parseInt(rawTimeout, 10);
		if (Number.isInteger(parsedTimeout) && parsedTimeout >= 0) turnTimeoutMs = parsedTimeout;
		else problems.push(\`AGENT_WEB_TURN_TIMEOUT_MS 不是合法毫秒数：\${rawTimeout}（回落到默认）\`);
	}

${engineDecl}`,
	);
	must(s.includes("\t\t\tengine,\n\t\t\ttoken:"), "返回对象");
	s = s.replace("\t\t\tengine,\n\t\t\ttoken:", "\t\t\tengine,\n\t\t\tturnTimeoutMs,\n\t\t\ttoken:");
	writeFileSync(path, s);
	console.log("env.ts 已改");
}

// ---------- runtime.ts ----------
{
	const path = "server/session/runtime.ts";
	let s = readFileSync(path, "utf8");
	must(s.includes("\t/** 客户端设置存储（ADR-0020 §P1）；不给就用默认值（单测用） */"), "options settings");
	s = s.replace(
		"\t/** 客户端设置存储（ADR-0020 §P1）；不给就用默认值（单测用） */",
		"\t/** 回合看门狗超时（ADR-0023）；不给就用默认 20 分钟 */\n\tturnTimeoutMs?: number;\n\t/** 客户端设置存储（ADR-0020 §P1）；不给就用默认值（单测用） */",
	);
	must(s.includes('import { settleTurnMarkers } from "./turn-markers.js";'), "imports");
	s = s.replace(
		'import { settleTurnMarkers } from "./turn-markers.js";',
		'import { settleTurnMarkers } from "./turn-markers.js";\nimport { createTurnWatchdog, DEFAULT_TURN_TIMEOUT_MS } from "./turn-watchdog.js";',
	);
	must(s.includes('\tlet rawTurnText = "";'), "rawTurnText");
	s = s.replace(
		'\tlet rawTurnText = "";',
		`\tlet rawTurnText = "";

	// 回合看门狗（ADR-0023）：卡住的回合要能自己收场 —— 全局只有 1 路在飞，卡一路等于堵死整个应用
	const watchdog = createTurnWatchdog({
		timeoutMs: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
		isWaitingForUser: () => state.pendingApproval !== null,
		onTimeout: (stuckConversationId) => {
			const minutes = Math.round((options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) / 60000);
			notice(\`回合超过 \${minutes} 分钟没结束，已自动中断（常见原因：某条命令卡住）\`, "warn");
			void options.engine.interrupt(stuckConversationId);
		},
	});`,
	);
	const startAnchor = '\t\t\t\tmarkerFilter = createMarkerStreamFilter();\n\t\t\t\trawTurnText = "";';
	must(s.includes(startAnchor), "turn 开始 anchor");
	s = s.replace(startAnchor, `${startAnchor}\n\t\t\t\twatchdog.start(conversationId);`);
	const finallyAnchor = "\t\t\t} finally {\n\t\t\t\t// 等落盘完成再放开「在飞」闸门";
	must(s.includes(finallyAnchor), "finally anchor");
	s = s.replace(finallyAnchor, "\t\t\t} finally {\n\t\t\t\twatchdog.stop();\n\t\t\t\t// 等落盘完成再放开「在飞」闸门");
	writeFileSync(path, s);
	console.log("runtime.ts 已接看门狗");
}
