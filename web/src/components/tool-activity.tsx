/**
 * 「现在在干什么」的统一说法：**工具名 + 一堆参数 → 一枚图标 + 一句人话**。
 *
 * 用户 2026-10-30（照 codex 的实时行）：「思考完要用什么工具、要做什么，实时的说出来；
 * 前面通过换小图标告诉现在是调工具还是调 skill」。codex 那一行写的是
 * 「正在读取 Weather Forecast 技能」「正在运行 curl …」—— 而不是 `read {"path":"…"}`。
 *
 * 所以这里把「引擎给的工具名」翻译成人话，并顺手定下图标种类：
 *   - 同一个说法**两套时态**（`now` 正在… / `done` 已…）：实时行用 now，跑完的步骤清单用 done，
 *     一处定义两处复用 —— 否则「正在读取」「已读取」两套正则迟早长歪（以前就在 MessageList 里
 *     和 ToolCard 里各写了一份工具名正则）。
 *   - `detail` 是行尾那截还能看的东西（命令 / 查询词 / 路径），没有就 null：实时行和步骤行都把它
 *     挂在同一行末尾，单行省略。抬头里**不重复** icon 已经在表达的语义（例如「读取」）。
 */

import { basename } from "../path-utils.ts";
import { skillNameOf } from "../skill-names.ts";
import { tNow } from "../use-language.ts";

export type ToolKind = "skill" | "read" | "list" | "run" | "search" | "web" | "edit" | "agent" | "other";

export type ToolActivity = {
	kind: ToolKind;
	/** 实时行：`正在读取 Weather Forecast 技能` */
	now: string;
	/** 步骤行：`已读取 weather.py` */
	done: string;
	/** 行尾那截参数：命令 / 查询词 / 路径；没有就是 null。**压短过的**（见 DETAIL_CHARS） */
	detail: string | null;
	/**
	 * 全文：给「点开看」的弹层用（用户 2026-10-30：「需要有个可以点开，我想点开看的时候，
	 * 可以点开看一眼到底在干嘛」）。行尾那截只能塞几十个字，`node -e '…'` 这种压完还是半截，
	 * 所以完整命令 / 脚本正文单独留一份，不进那一行。没有更多可看的（读文件、列目录）就是 null。
	 */
	full: string | null;
};

/**
 * 行尾那句话的长度上限。
 *
 * 以前给到 240（想把脚本正文尽量露出来），实跑下来是「一行里塞了半条命令 + 省略号」——
 * 用户 2026-10-30：「你的脚本显示不全就别显示这么长」。既然压短也看不全，就让这一行只做
 * 「扫一眼知道在跑什么」，全文交给点开后的弹层（`full`）。
 */
const DETAIL_CHARS = 64;

/**
 * 脚本正文在行尾只留这么点。
 *
 * 比命令更短：脚本代码反正永远显示不全（半句 `fs.readdirSync(…)` 也看不出意图），
 * 那就不占位置 —— 抬头的「正在跑 Node 脚本」负责说清在干什么，全文留给弹层。
 */
const SCRIPT_DETAIL_CHARS = 48;

/** 跑命令的工具 */
const RUN = /^(bash|sh|shell|shell_command|exec|run|run_command|terminal|powershell)$/i;
/** 读文件的工具 */
const READ = /^(read|view|cat|open|read_file|readfile)$/i;
/** 列目录的工具（bash 里的 `ls` 另外单独认，见 LIST_COMMAND） */
const LIST = /^(list|ls|list_files|listfiles|glob|tree|dir)$/i;
/** 检索的工具 */
const SEARCH = /^(grep|rg|search|find|search_files|find_files)$/i;
/** 写文件的工具 */
const EDIT = /^(write|edit|str_replace|apply_patch|patch|multi_edit|multiedit|notebook_edit|create_file)$/i;
/** 联网的工具 */
const WEB = /^(web_search|websearch|webfetch|web_fetch|fetch|browse|fetch_content)$/i;
/** 派子代理的工具 */
const AGENT = /^(agent|task|subagent|delegate)$/i;
/** 用 bash 跑 `ls` / `find` / `tree` 其实是在列目录：图标要跟着动作走，不跟着工具名走 */
const LIST_COMMAND = /^\s*(ls|dir|tree|find)\b/;

/**
 * 直接从网上拉数据（curl / wget 之类）：说成「联网抓取」，不说「运行 curl」。
 * 用户 2026-10-30：「要 curl 远程地址什么的，你都没有讲」—— 拉远程地址本身就是「联网」，
 * 图标也应该跟着变地球，而不是终端。
 */
const FETCH_COMMAND = /^\s*(?:cd\s+\S+\s*&&\s*)*(curl|wget|http|httpie|aria2c)\b/;

/** 从命令里抠出要抓的地址（第一个 http(s) URL） */
function urlOf(command: string): string | null {
	const match = /(https?:\/\/[^\s'"|;&)]+)/.exec(command);
	return match?.[1] ?? null;
}

/**
 * 跑脚本的解释器：`python3 - <<'PY'` / `node -e '…'` / `node --import tsx -e '…'` / `bash -c '…'`
 * 都算「在跑一段脚本」。
 *
 * 为什么单拎出解释器再往后找：`node --import tsx -e` 中间夹着带值的 flag，一条正则很难既认
 * heredoc 又认 eval。用户 2026-10-30 看到的那行就是 `正在运行 node --import tsx -e ' const fs=require…`：
 * 没认出脚本，于是把整条命令糊在行尾。
 */
const SCRIPT_INTERP = /(?:^|[\s&|;])(python3?|node|deno|bun|ruby|perl|php|bash|sh|zsh)\b/g;
/** eval 写法：`node -e '…'` / `python -c '…'` / `deno eval '…'`（解释器之后那一段里找） */
const EVAL_FLAG = /(?:^|\s)(?:-e|--eval|-c|eval)\s+([\s\S]*)$/;

/**
 * 常见命令的「人话」翻译。
 *
 * 用户 2026-10-30：「把 bash 的显示改成「正在跑脚本」这种人话」—— 「正在运行」+ 原命令
 * 等于把参数重念一遗；人想知道的是「它在干什么事」（跑测试？构建？装依赖？提交？）。
 * 只认最熟的几条，认不出来就老实说「正在跑命令」—— 不猜、不编，命令本身仍挂在行尾。
 */
const TEST_COMMAND =
	/(?:^|[\s&|;])(?:pytest|py\.test|vitest|jest|mocha|ava|playwright\s+test|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test)\b/;
const BUILD_COMMAND =
	/(?:^|[\s&|;])(?:npm\s+run\s+build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|vite\s+build|tsc\b|make\b|cargo\s+build|go\s+build|webpack|rollup)\b/;
const INSTALL_COMMAND =
	/(?:^|[\s&|;])(?:npm\s+(?:i|install|ci)|pnpm\s+(?:i|install|add)|yarn\s+(?:add|install)|pip3?\s+install|uv\s+(?:pip\s+)?install|brew\s+install|cargo\s+install)\b/;
const GIT_COMMAND = /(?:^|[\s&|;])git\s+([a-z-]+)/;
/** git 子命令 → 说法（只收日常会做的几个；其余退回「git <子命令>」） */
const GIT_VERB: Record<string, [string, string]> = {
	commit: ["正在提交改动", "已提交改动"],
	push: ["正在推送", "已推送"],
	pull: ["正在拉取", "已拉取"],
	fetch: ["正在同步远端", "已同步远端"],
	status: ["正在看改动状态", "已看改动状态"],
	diff: ["正在看差异", "已看差异"],
	log: ["正在看提交历史", "已看提交历史"],
	checkout: ["正在切分支", "已切分支"],
	switch: ["正在切分支", "已切分支"],
	merge: ["正在合并", "已合并"],
	rebase: ["正在变基", "已变基"],
	stash: ["正在暂存改动", "已暂存改动"],
	add: ["正在暂存文件", "已暂存文件"],
	clone: ["正在克隆仓库", "已克隆仓库"],
};

/** 一条命令在干什么（认不出来返回 null，调用方退回「正在跑命令」） */
function runVerbOf(command: string): { now: [string, string]; done: [string, string] } | null {
	if (TEST_COMMAND.test(command))
		return { now: ["正在跑测试", "Running the tests"], done: ["已跑完测试", "Ran the tests"] };
	if (BUILD_COMMAND.test(command)) return { now: ["正在构建", "Building"], done: ["已构建完成", "Built"] };
	if (INSTALL_COMMAND.test(command))
		return { now: ["正在安装依赖", "Installing dependencies"], done: ["已安装依赖", "Installed dependencies"] };
	const git = GIT_COMMAND.exec(command)?.[1];
	const verb = git ? GIT_VERB[git] : undefined;
	if (verb) return { now: [verb[0], `Running git ${git}`], done: [verb[1], `Ran git ${git}`] };
	return null;
}

const SCRIPT_LANG: Record<string, string> = {
	python: "Python",
	python3: "Python",
	node: "Node",
	deno: "Deno",
	bun: "Bun",
	ruby: "Ruby",
	perl: "Perl",
	bash: "shell",
	sh: "shell",
	zsh: "shell",
};

/**
 * heredoc 写法：`python3 - <<'PY'` 后面那些行（解释器之后那段 `rest` 里找）。
 *
 * 结束标记（`<<'PY'` → PY）那一行不是脚本内容，得剔掉；正文为空就返回 null，交给别的写法。
 */
function heredocCode(rest: string): string | null {
	const at = rest.indexOf("<<");
	if (at < 0) return null;
	const marker = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(rest.slice(at))?.[1] ?? null;
	const newline = rest.indexOf("\n", at);
	if (newline < 0) return null;
	const lines = rest.slice(newline + 1).split("\n");
	if (marker && (lines.at(-1) ?? "").trim() === marker) lines.pop();
	const code = lines.join("\n").trim();
	return code === "" ? null : code;
}

/**
 * eval 写法：`node -e '…'` / `node --import tsx -e '…'` / `python3 -c "…"`。
 *
 * 引号里的内容原样取出（首尾同一种引号就去掉一层）；取不到引号就整段当正文，不硬凑。
 */
function evalCode(rest: string): string | null {
	const body = EVAL_FLAG.exec(rest)?.[1]?.trim();
	if (!body) return null;
	const quote = body[0];
	if ((quote === "'" || quote === '"') && body.length > 1) {
		const inner = body.slice(1);
		const end = inner.lastIndexOf(quote);
		const code = (end >= 0 ? inner.slice(0, end) : inner).trim();
		return code === "" ? null : code;
	}
	return body;
}

/**
 * 认出「在跑一段脚本」：返回语言 + 脚本正文。
 *
 * 为什么要拆出来：脚本命令的抬头只写「正在运行 python3 - <<'PY'」等于什么都没说；
 * 正文（heredoc，或 `-e` 后面那段）才知道它在请求哪个地址、要算什么（用户 2026-10-30）。
 * 两种写法都取不到就返回 null，退回「正在跑命令」+ 整条命令。
 */
function scriptOf(command: string): { lang: string; code: string } | null {
	for (const match of command.matchAll(SCRIPT_INTERP)) {
		const lang = SCRIPT_LANG[match[1].toLowerCase()] ?? match[1];
		const rest = command.slice((match.index ?? 0) + match[0].length);
		const code = heredocCode(rest) ?? evalCode(rest);
		if (code) return { lang, code };
	}
	return null;
}

/** 参数摘要里能抽出来的字段（键名各引擎不一样，都认一遍） */
type Fields = {
	path: string | null;
	command: string | null;
	pattern: string | null;
	query: string | null;
	description: string | null;
};

const EMPTY: Fields = { path: null, command: null, pattern: null, query: null, description: null };

/** 压成一行：多行命里只留第一行，多余空白合并，超长截断（短字段用：文件名 / 查询词） */
function oneLine(text: string, limit = 120): string {
	const flat = (text.split(/\r?\n/, 1)[0] ?? "").replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 压成**一行但不只取第一行**（行尾详情用）。
 *
 * 以前详情用的就是 `oneLine`（只取第一行），于是 `python3 - <<'PY'` 这种脚本命令只剩
 * 「python3 - <<'PY'」半截，看着像被截断了（用户 2026-10-30：「感觉你显示的也不全」）。
 * 现在把整段压平，再由 CSS 折成两行、超出省略 —— 能看出脚本里在请求什么地址。
 */
function flatText(text: string, limit = DETAIL_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function pick(record: Record<string, unknown>, keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") return value;
		// 有的工具把多个值塞进数组（`{"queries":["a","b"]}`）：取第一个就够说了
		if (Array.isArray(value)) {
			const first = value.find((item) => typeof item === "string" && item.trim() !== "");
			if (typeof first === "string") return first;
		}
	}
	return null;
}

/**
 * JSON 字符串里的转义还原（`\u0026` → `&`、`\n` → 换行）。
 * 命令里带 `&&`、引号的很多（`cd /tmp && python3 - <<'PY'`），不还原就是满屏反斜杠。
 */
function unescapeJson(fragment: string): string {
	return fragment
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

/** 从半截 JSON 里抠一个字符串值（键后面得是冒号 + 左引号） */
function salvageValue(text: string, key: string): string | null {
	// 正常结束的字符串
	const quoted = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
	if (quoted?.[1] !== undefined && quoted[1] !== "") return unescapeJson(quoted[1]);
	// 截断在值中间（摘要常常正好截在命令里）：把剩下的都当值，反正后面也只是省略号
	const open = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*)`).exec(text);
	return open?.[1] ? unescapeJson(open[1]) : null;
}

/**
 * 从参数摘要里挑出「好看的那几个字段」。
 *
 * 摘要**可能已经被截断过**（`{"command":"cd /tmp && python3 - <<'PY' …`），那种 JSON parse 不出来 ——
 * 但那不是错误：用正则把字段抠出来就行（`salvageValue`）。抠不到才退到空字段，
 * 这时抬头只剩「正在运行」，参数交给 `fallback`（见 describeTool）。
 */
function fieldsOf(raw: string): Fields {
	const text = raw.trim();
	if (text === "") return EMPTY;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// 截断过的 JSON：按字段名抠（顺序有意义 —— grep 的 pattern 比 query 具体）
		const path = salvageValue(text, "path") ?? salvageValue(text, "file_path");
		return {
			path,
			command: salvageValue(text, "command"),
			pattern: salvageValue(text, "pattern") ?? salvageValue(text, "regex"),
			query: salvageValue(text, "query") ?? salvageValue(text, "url"),
			description: salvageValue(text, "description"),
		};
	}
	if (typeof parsed === "string") return { ...EMPTY, command: parsed };
	if (!parsed || typeof parsed !== "object") return EMPTY;
	const record = parsed as Record<string, unknown>;
	const path = pick(record, ["path", "file_path", "filePath", "file", "target_file"]);
	return {
		path,
		command: pick(record, ["command", "cmd", "script"]),
		// grep 的 pattern 优先；没有再退到 query（有的检索工具只给 query）
		pattern: pick(record, ["pattern", "regex", "query"]),
		query: pick(record, ["query", "queries", "q", "url", "prompt"]),
		description: pick(record, ["description", "task", "prompt", "subagent_type"]),
	};
}

/** `weather-forecast` → `Weather Forecast`（技能目录名 / 真名都是人写的 slug，摆进句子里要像人名） */
function prettyName(slug: string): string {
	return slug
		.split(/[-_.\s]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/**
 * 目录名 → 摆进句子里的技能名。
 *
 * 优先用 `SKILL.md` frontmatter 里的真名（`new-skill-3` → `weather-forecast` → `Weather Forecast`），
 * 拿不到才退回目录名 —— 目录名是安装时的 slug，经常就是个 `new-skill-3` 这种编号（见 skill-names.ts）。
 */
function skillDisplay(slug: string): string {
	return prettyName(skillNameOf(slug) ?? slug);
}

/**
 * 技能文件的识别：`…/.agents/skills/<slug>/SKILL.md`。
 * 用户看到的应该是**技能名**（Weather Forecast），不是路径，也不是 `SKILL.md`。
 */
function skillSlugOf(path: string): string | null {
	const match = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i.exec(path);
	return match?.[1] ?? null;
}

/**
 * 这条工具调用是不是在加载技能：是就返回技能名（`Weather Forecast`），否则 null。
 *
 * 单拎出来是因为它有两处用途：实时行、完成步骤行里说「正在/已读取 X 技能」（describeTool），
 * 以及「过程」折叠行里报「技能 Weather Forecast」（用户 2026-10-30：
 * 「你要调用什么 skill 时要说出来，我要看到」—— 跑完只剩「2 次工具」等于把这件事藏起来了）。
 */
export function skillOf(name: string, argsSummary: string): string | null {
	if (!READ.test(name)) return null;
	const path = fieldsOf(argsSummary).path;
	const slug = path ? skillSlugOf(path) : null;
	return slug ? skillDisplay(slug) : null;
}

/**
 * 工具调用 → 图标种类 + 两种时态的说法。
 *
 * 一律**不抛异常**：认不出来的工具（新引擎、MCP 工具）退到 `other`，照样有一行能看，只是没有彩色语义。
 */
export function describeTool(name: string, argsSummary: string): ToolActivity {
	const fields = fieldsOf(argsSummary);
	const path = fields.path;
	const file = path ? basename(path) : null;
	const fallback = (() => {
		// parse 失败时：把摘要原文压成一行当参数，总比什么都不显示强
		const raw = argsSummary.trim();
		return raw === "" ? null : flatText(raw);
	})();

	// 读 SKILL.md = 加载技能（用户嘴里就是「调 skill」，不是「读文件」）
	const skill = skillOf(name, argsSummary);
	if (skill) {
		return {
			kind: "skill",
			now: tNow(`正在读取 ${skill} 技能`, `Reading the ${skill} skill`),
			done: tNow(`已读取 ${skill} 技能`, `Read the ${skill} skill`),
			detail: null,
			full: null,
		};
	}

	// bash 跑 `ls` / `find` / `tree`：动作是「列目录」，不是「跑命令」
	if (RUN.test(name) && fields.command && LIST_COMMAND.test(fields.command)) {
		const tokens = fields.command
			.trim()
			.split(/\s+/)
			.filter((token) => !token.startsWith("-"));
		const target = tokens[1] ? basename(tokens[1]) : null;
		return {
			kind: "list",
			now: target ? tNow(`正在列出 ${target}`, `Listing ${target}`) : tNow("正在列出目录", "Listing a directory"),
			done: target ? tNow(`已列出 ${target}`, `Listed ${target}`) : tNow("已列出目录", "Listed a directory"),
			detail: null,
			full: null,
		};
	}

	if (LIST.test(name)) {
		const target = file ?? fallback;
		return {
			kind: "list",
			now: target ? tNow(`正在列出 ${target}`, `Listing ${target}`) : tNow("正在列出目录", "Listing a directory"),
			done: target ? tNow(`已列出 ${target}`, `Listed ${target}`) : tNow("已列出目录", "Listed a directory"),
			detail: null,
			full: null,
		};
	}

	if (WEB.test(name)) {
		const query = fields.query ?? fields.pattern;
		return {
			kind: "web",
			now: tNow("正在联网查询", "Searching the web"),
			done: tNow("已联网查询", "Searched the web"),
			detail: query ? oneLine(query, 80) : fallback,
			full: query ?? fallback,
		};
	}

	if (EDIT.test(name)) {
		const target = file ?? path ?? null;
		return {
			kind: "edit",
			now: target ? tNow(`正在修改 ${target}`, `Editing ${target}`) : tNow("正在修改文件", "Editing a file"),
			done: target ? tNow(`已修改 ${target}`, `Edited ${target}`) : tNow("已修改文件", "Edited a file"),
			detail: null,
			full: null,
		};
	}

	if (READ.test(name)) {
		const target = file ?? fallback;
		return {
			kind: "read",
			now: target ? tNow(`正在读取 ${target}`, `Reading ${target}`) : tNow("正在读取文件", "Reading a file"),
			done: target ? tNow(`已读取 ${target}`, `Read ${target}`) : tNow("已读取文件", "Read a file"),
			detail: null,
			full: null,
		};
	}

	if (SEARCH.test(name)) {
		const target = fields.pattern ?? fallback;
		return {
			kind: "search",
			now: tNow("正在检索", "Searching"),
			done: tNow("已检索", "Searched"),
			detail: target ? oneLine(target, 80) : null,
			full: target,
		};
	}

	if (AGENT.test(name)) {
		const target = fields.description ? oneLine(fields.description, 60) : null;
		return {
			kind: "agent",
			now: tNow("正在派出子代理", "Starting a subagent"),
			done: tNow("已派出子代理", "Started a subagent"),
			detail: target,
			full: fields.description,
		};
	}

	if (RUN.test(name)) {
		const command = fields.command;
		// curl/wget 拉远程地址 = 联网（图标变地球，说法变「抓取」），不是「跑命令」
		if (command && FETCH_COMMAND.test(command)) {
			const url = urlOf(command);
			const host = url ? url.replace(/^https?:\/\//, "").split("/")[0] : null;
			return {
				kind: "web",
				now: host ? tNow(`正在抓取 ${host}`, `Fetching ${host}`) : tNow("正在联网抓取", "Fetching a remote URL"),
				done: host ? tNow(`已抓取 ${host}`, `Fetched ${host}`) : tNow("已联网抓取", "Fetched a remote URL"),
				detail: url ? flatText(url) : null,
				full: command,
			};
		}
		// 一段脚本（heredoc）：说「在跑 Python 脚本」并把脚本正文摆出来，而不是半截 `<<'PY'`
		const script = command ? scriptOf(command) : null;
		if (script) {
			return {
				kind: "run",
				now: tNow(`正在跑 ${script.lang} 脚本`, `Running a ${script.lang} script`),
				done: tNow(`已跑完 ${script.lang} 脚本`, `Ran a ${script.lang} script`),
				detail: flatText(script.code, SCRIPT_DETAIL_CHARS),
				full: script.code,
			};
		}
		// 测试 / 构建 / 装依赖 / git 操作：说「在干什么事」，不是「正在运行 + 原命令」
		const verb = command ? runVerbOf(command) : null;
		if (verb) {
			return {
				kind: "run",
				now: tNow(verb.now[0], verb.now[1]),
				done: tNow(verb.done[0], verb.done[1]),
				detail: command ? flatText(command) : fallback,
				full: command ?? fallback,
			};
		}
		return {
			kind: "run",
			now: tNow("正在跑命令", "Running a command"),
			done: tNow("已跑完命令", "Ran a command"),
			detail: command ? flatText(command) : fallback,
			full: command ?? fallback,
		};
	}

	// 认不出来的（MCP / 新工具 / 别的引擎）：至少把名字原样摆出来
	return {
		kind: "other",
		now: tNow(`正在执行 ${name}`, `Running ${name}`),
		done: tNow(`已执行 ${name}`, `Ran ${name}`),
		detail: fallback,
		full: argsSummary.trim() === "" ? null : argsSummary,
	};
}

/** 16 格线性图标：描边 1.3、圆头圆角，和 PanelIcon / FolderIcon 那套一致（不用 emoji，跨系统不打架） */
const STROKE = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.3,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

/**
 * 动作图标：**看图标就知道现在是在调 skill、读文件、列目录，还是在跑命令**（用户 2026-10-30）。
 * `thinking` 是「没在调工具、也没在说话」时用的（等模型 / 自动重试）。
 */
export function ToolKindIcon({ kind, className }: { kind: ToolKind | "thinking"; className?: string }) {
	const common = { viewBox: "0 0 16 16", "aria-hidden": true, className };
	if (kind === "thinking")
		// 一颗四角星：不是工具，是「在想」
		return (
			<svg {...common}>
				<path d="M6.9 2.6l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1Z" {...STROKE} />
				<path d="M11.9 9.5l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6Z" {...STROKE} />
			</svg>
		);
	if (kind === "skill")
		// 摊开的书：加载一份技能（说明书）
		return (
			<svg {...common}>
				<path
					d="M8 4.3C7.1 3.4 5.6 3 3.1 3v8.3c2.4 0 3.9.4 4.9 1.3 1-.9 2.5-1.3 4.9-1.3V3c-2.5 0-4 .4-4.9 1.3Z"
					{...STROKE}
				/>
				<path d="M8 4.3v8.3" {...STROKE} />
			</svg>
		);
	if (kind === "read")
		// 文件 + 两条正文
		return (
			<svg {...common}>
				<path d="M4.1 2h4.5l3.1 3.1V13a1 1 0 0 1-1 1H4.1a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" {...STROKE} />
				<path d="M8.5 2.1v3.3h3.2" {...STROKE} />
				<path d="M5.3 8.2h5.4" {...STROKE} />
				<path d="M5.3 10.5h3.6" {...STROKE} />
			</svg>
		);
	if (kind === "list")
		// 文件夹：列目录
		return (
			<svg {...common}>
				<path
					d="M2.4 12.2a1.2 1.2 0 0 1-1.2-1.2V5a1.2 1.2 0 0 1 1.2-1.2h3.1a1.2 1.2 0 0 1 .95.48l.6.8a1.2 1.2 0 0 0 .95.48h5.4a1.2 1.2 0 0 1 1.2 1.2v4.2a1.2 1.2 0 0 1-1.2 1.2Z"
					{...STROKE}
				/>
			</svg>
		);
	if (kind === "run")
		// 终端：跑命令
		return (
			<svg {...common}>
				<rect x="1.9" y="2.9" width="12.2" height="10.2" rx="1.8" {...STROKE} />
				<path d="M4.6 6.3 6.6 8l-2 1.7" {...STROKE} />
				<path d="M8.6 10.4h3" {...STROKE} />
			</svg>
		);
	if (kind === "web")
		// 地球：联网
		return (
			<svg {...common}>
				<circle cx="7.6" cy="7.6" r="5.1" {...STROKE} />
				<path d="M2.5 7.6h10.2" {...STROKE} />
				<ellipse cx="7.6" cy="7.6" rx="2.3" ry="5.1" {...STROKE} />
			</svg>
		);
	if (kind === "search")
		// 放大镜
		return (
			<svg {...common}>
				<circle cx="7" cy="7" r="3.9" {...STROKE} />
				<path d="M9.9 9.9 13.2 13.2" {...STROKE} />
			</svg>
		);
	if (kind === "edit")
		// 铅笔：改文件
		return (
			<svg {...common}>
				<path d="M10.9 2.6 13.4 5.1 5.8 12.7l-3.1.6.6-3.1Z" {...STROKE} />
				<path d="M9.5 4 12 6.5" {...STROKE} />
			</svg>
		);
	if (kind === "agent")
		// 小机器人：派子代理
		return (
			<svg {...common}>
				<rect x="3" y="4.9" width="10" height="7.4" rx="2" {...STROKE} />
				<path d="M8 4.9V2.7" {...STROKE} />
				<circle cx="6" cy="8.4" r="0.75" fill="currentColor" stroke="none" />
				<circle cx="10" cy="8.4" r="0.75" fill="currentColor" stroke="none" />
			</svg>
		);
	// other：扳手
	return (
		<svg {...common}>
			<path
				d="M10.4 2.3a3.1 3.1 0 0 0-3.6 4.1l-4.3 4.3a1.3 1.3 0 0 0 1.8 1.8l4.3-4.3a3.1 3.1 0 0 0 4.1-3.6l-1.9 1.9-1.9-.4-.4-1.9Z"
				{...STROKE}
			/>
		</svg>
	);
}
