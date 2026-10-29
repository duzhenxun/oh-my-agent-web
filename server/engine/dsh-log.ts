/**
 * DSH 会话日志（v4）的只读解析 —— 侧栏标题、历史回放、token 统计都靠它。
 *
 * 为什么必须自己读文件：ACP 明确不支持 `session/load`（不回放历史），
 * 所以「打开一条历史会话」只能读 DSH 自己落盘的日志。这里只**读**，从不写。
 *
 * 布局（dsh 0.2.0-rc.2，实测）：
 *   <DSH_HOME>/sessions/<projectKey(cwd)>/session-<uuid>/session.v4.jsonl.zstd
 * 每个写批次追加**一个 zstd 帧** → 必须多帧解压（`zstdDecompressSync` 只解首帧）。
 * 帧内是 JSONL：第一行 `{type:"session",version:4,id,cwd,createdAt…}`，之后逐行事件
 * `{type, seq, time, data}`。
 *
 * 事件面（v4 实测，只列 UI 用得到的）：
 *   user/message      data:{content:[{type:"text",text}], source:{kind}, id}
 *   assistant/message data:{turn,step,message:{role,content:[reasoning|text|tool-call],id},usage,stream}
 *   tool/result       data:{turn,step,message:{toolCallId,content:[{type:"text",text}],isError}}
 *   session/title     data:{title,source}
 *   turn/start|end、step/start|end、session 等结构性事件（不进 UI）
 *
 * ⚠️ `user/message` 里大量是**系统注入**（runtime-context / skill-catalog / goal …）：
 * 只有 `source.kind === "user"` 才是真的用户发言，其余一律不进对话区、也不拿来取标题。
 */
import { existsSync, readFileSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

type DshLogEvent = {
	type: string;
	seq?: number;
	time?: number;
	data?: Record<string, unknown>;
};

type DshSessionHeader = {
	id?: string;
	cwd?: string;
	createdAt?: number;
	version?: number;
	[key: string]: unknown;
};

export type DshSessionLog = { header: DshSessionHeader | null; events: DshLogEvent[] };

/** projectKey(cwd) —— 镜像 DSH 的会话目录命名：分隔符 → "-"，其它非法字符 → ~XXXX（大写 hex） */
function projectKey(cwd: string): string {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i += 1) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** 多帧 zstd 解压：按魔数切帧；切错了就向后合并重试（数据体里可能误命中魔数） */
function zstdDecompressAll(buf: Buffer): string {
	const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const starts: number[] = [];
	for (let i = 0; i + 4 <= buf.length; i += 1) {
		if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
			starts.push(i);
		}
	}
	let out = "";
	let index = 0;
	while (index < starts.length) {
		const from = starts[index];
		let next = index + 1;
		let decompressed: Buffer | null = null;
		while (next <= starts.length) {
			const to = next < starts.length ? starts[next] : buf.length;
			try {
				decompressed = zstdDecompressSync(buf.subarray(from, to));
				break;
			} catch {
				next += 1;
			}
		}
		if (decompressed) {
			out += decompressed.toString("utf8");
			index = next;
		} else {
			index += 1;
		}
	}
	return out || buf.toString("utf8");
}

/** 读一个会话日志文件 → { header, events }（坏行跳过，不因为一行报废整份历史） */
export function readSessionLog(file: string): DshSessionLog {
	const raw = readFileSync(file);
	const text = file.endsWith(".zstd") ? zstdDecompressAll(raw) : raw.toString("utf8");
	let header: DshSessionHeader | null = null;
	const events: DshLogEvent[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (value?.type === "session") {
			header = value as DshSessionHeader;
			continue;
		}
		if (typeof value?.type === "string") events.push(value as DshLogEvent);
	}
	return { header, events };
}

/** 只读文件头（第一帧的前几 KB）—— 扫侧栏时不必解整份日志 */
export function readSessionHeader(file: string): DshSessionHeader | null {
	if (!file.endsWith(".zstd")) {
		const text = readFileSync(file, "utf8");
		const first = text.split("\n").find((line) => line.trim() !== "");
		try {
			return first ? (JSON.parse(first) as DshSessionHeader) : null;
		} catch {
			return null;
		}
	}
	const handle = readFileSync(file);
	const chunk = handle.subarray(0, Math.min(handle.length, 16 * 1024));
	const text = zstdDecompressAll(chunk);
	const first = text.split("\n").find((line) => line.trim() !== "");
	try {
		return first ? (JSON.parse(first) as DshSessionHeader) : null;
	} catch {
		return null;
	}
}

/** 系统注入的 user/message？白名单铁律：`source.kind !== "user"` 一律不算用户发言 */
export function isInternalUserMessage(data: Record<string, unknown> | undefined): boolean {
	if (!data) return false;
	const source = data.source as { kind?: unknown } | undefined;
	if (source && typeof source.kind === "string") return source.kind !== "user";
	// 老版本没有 source：靠文本特征兜底
	const content = data.content as Array<{ type?: string; text?: string }> | undefined;
	if (!Array.isArray(content)) return false;
	return content.some(
		(block) =>
			typeof block?.text === "string" &&
			(block.text.includes("<system-reminder>") ||
				block.text.includes("<goal_round") ||
				block.text.startsWith("Current runtime context") ||
				block.text.includes("Current DSH file policy:")),
	);
}

function textOf(blocks: unknown): string {
	if (!Array.isArray(blocks)) return "";
	return blocks
		.map((block) => {
			const item = block as { type?: string; text?: string };
			return item?.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.join("");
}

/** 会话标题：日志里最后一条 `session/title`（DSH 自己也会写 fallback 标题） */
export function sessionTitle(log: DshSessionLog): string | null {
	let title: string | null = null;
	for (const event of log.events) {
		if (event.type !== "session/title") continue;
		const value = (event.data as { title?: unknown } | undefined)?.title;
		if (typeof value === "string" && value.trim() !== "") title = value.trim();
	}
	return title;
}

/** 首条真实用户发言（标题兜底） */
export function firstUserText(log: DshSessionLog, maxChars = 30): string | null {
	for (const event of log.events) {
		if (event.type !== "user/message") continue;
		if (isInternalUserMessage(event.data)) continue;
		const text = textOf(event.data?.content).trim().replace(/\s+/g, " ");
		if (text !== "") return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
	}
	return null;
}

/** 按会话 id 找它的日志文件：优先用 cwd 直算目录，否则在 sessions 下一层找 */
export function locateSessionFile(sessionRoot: string, sessionId: string, cwd?: string): string | null {
	const candidates: string[] = [];
	const names = ["session.v4.jsonl.zstd", "session.jsonl.zstd"];
	if (cwd) for (const name of names) candidates.push(join(sessionRoot, projectKey(cwd), sessionId, name));
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	// cwd 未知（历史会话还没打开过）：扫一层
	let groups;
	try {
		groups = readdirSync(sessionRoot, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const group of groups) {
		if (!group.isDirectory()) continue;
		for (const name of names) {
			const candidate = join(sessionRoot, group.name, sessionId, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * 删掉一条会话在 DSH 自己存储里的目录（`<sessions>/<projectKey>/<sessionId>/`）。
 *
 * 用途只有一个：**模型目录探针**临时开的那条会话（见 catalog-probe.ts）别留在
 * DSH 的 web / tui 历史里。做法是先按 cwd 直算、再扫一层（与 locateSessionFile 同样的
 * 两条路径）—— 目录命名细节不对也知道要删哪个，删不掉就算了，侧栏还要按临时目录过滤。
 *
 * 返回 true = 真的删掉了。
 */
export function deleteDshSession(sessionRoot: string, sessionId: string, cwd?: string): boolean {
	const groups: string[] = [];
	if (cwd) groups.push(projectKey(cwd));
	try {
		for (const entry of readdirSync(sessionRoot, { withFileTypes: true })) {
			if (entry.isDirectory() && !groups.includes(entry.name)) groups.push(entry.name);
		}
	} catch {
		return false;
	}
	let removed = false;
	for (const group of groups) {
		const dir = join(sessionRoot, group, sessionId);
		if (!existsSync(dir)) continue;
		try {
			rmSync(dir, { recursive: true, force: true });
			removed = true;
			// 组目录空了就一起删（DSH 自己也会留一堆空目录，但没必要再添一个）
			try {
				rmdirSync(join(sessionRoot, group));
			} catch {
				/* 还有别的会话在里头 */
			}
		} catch {
			/* 删不掉就算了 */
		}
	}
	return removed;
}
