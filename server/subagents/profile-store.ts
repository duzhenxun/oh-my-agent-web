/**
 * 子代理模板（profiles）：**配置就是真相**，落盘在自己能看见的目录里。
 *
 * 落点 `~/.pi/agent/agents/*.md`（与 pi 的 agent 目录同一个位置）：
 *   - 一个模板 = 一个 markdown 文件，frontmatter 描述「谁能用、用哪些工具」，
 *     正文就是子代理的系统指令（人可以直接编辑、可以进 git）；
 *   - 内置三档（explore / general-purpose / plan）写在代码里，**没有文件**，
 *     面板里的「创建副本」会把它们复制成用户文件，之后就能改；
 *   - 启停 / 并发数落 `agents/settings.json`，且只动我们自己那一个键
 *     （同一个文件还有别的工具在写，不能把别人的键写没）。
 *
 * 这个模块**不 import 任何 SDK**：宿主（面板 / 运行时）与引擎（起子会话）都读同一份磁盘事实。
 */
import { tempPathFor } from "../util/atomic-write.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentProfileView, SubagentSettingsView } from "../protocol.js";

/** 运行时用的一份模板（引擎要的就是这几个字段） */
type SubagentProfileSpec = {
	id: string;
	label: string;
	description: string;
	systemPrompt: string;
	tools: string[];
	model?: string;
	thinking?: string;
	maxTurns?: number;
	enabled: boolean;
	builtin: boolean;
};

/** 子代理能选的工具（面板的勾选框就是这一份，顺序即显示顺序） */
const SUBAGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

const SETTINGS_KEY = "oh-my-agent-web";

const DEFAULTS: SubagentProfileSpec[] = [
	{
		id: "explore",
		label: "Explore",
		description: "只读侦察：不改进仓库，把结论与文件路径带回来",
		systemPrompt:
			"Explore the codebase to answer the delegated question. Do not modify files. Report concrete findings with file paths and relevant symbols.",
		tools: ["read", "grep", "find", "ls"],
		thinking: "low",
		maxTurns: 14,
		enabled: true,
		builtin: true,
	},
	{
		id: "general-purpose",
		label: "General purpose",
		description: "通用委派：窄而正确地改代码，验证后如实汇报",
		systemPrompt:
			"Complete the delegated task end to end. Prefer the smallest correct change, verify it before reporting, and report what you changed with file paths. If you cannot finish, say exactly what is left.",
		tools: [...SUBAGENT_TOOLS],
		maxTurns: 40,
		enabled: true,
		builtin: true,
	},
	{
		id: "plan",
		label: "Plan",
		description: "只出方案：读代码、给步骤与风险，不动文件",
		systemPrompt:
			"Design an implementation plan for the delegated task. Read code as needed but do not modify it. Return ordered steps, files to touch, risks, and what to verify.",
		tools: ["read", "grep", "find", "ls"],
		thinking: "medium",
		maxTurns: 16,
		enabled: true,
		builtin: true,
	},
];

function agentsDir(agentDir: string): string {
	return join(agentDir, "agents");
}

function agentsSettingsPath(agentDir: string): string {
	return join(agentsDir(agentDir), "settings.json");
}

// ---------------------------------------------------------------------------
// frontmatter：只认我们写的那几个键（够用、不引 yaml 依赖）
// ---------------------------------------------------------------------------

type RawFrontmatter = Record<string, string>;

function parseFrontmatter(text: string): { meta: RawFrontmatter; body: string } {
	const normalized = text.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return { meta: {}, body: normalized.trim() };
	const end = normalized.indexOf("\n---", 4);
	if (end < 0) return { meta: {}, body: normalized.trim() };
	const block = normalized.slice(4, end);
	const body = normalized
		.slice(end + 4)
		.replace(/^\n+/, "")
		.trim();
	const meta: RawFrontmatter = {};
	let lastKey = "";
	for (const line of block.split("\n")) {
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		// 续行（YAML 的 `|` 折叠块）：并进上一行的值
		if (/^\s+/.test(line) && lastKey !== "") {
			meta[lastKey] = `${meta[lastKey]} ${line.trim()}`.trim();
			continue;
		}
		const at = line.indexOf(":");
		if (at < 0) continue;
		const key = line.slice(0, at).trim().toLowerCase();
		let value = line.slice(at + 1).trim();
		if (value === "|" || value === ">" || value === "|-") value = "";
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		meta[key] = value;
		lastKey = key;
	}
	return { meta, body };
}

function listOf(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.replace(/^\[/, "")
		.replace(/\]$/, "")
		.split(",")
		.map((item) => item.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

function profileFromFile(file: string, text: string): SubagentProfileSpec | null {
	const { meta, body } = parseFrontmatter(text);
	const id = (meta.name ?? meta.id ?? "").trim() || file.replace(/\.md$/i, "");
	if (id === "") return null;
	const tools = listOf(meta.tools);
	return {
		id,
		label: meta.display_name?.trim() || meta.displayname?.trim() || meta.label?.trim() || id,
		description: meta.description?.trim() || "",
		systemPrompt: body,
		tools: tools.length > 0 ? tools : [...SUBAGENT_TOOLS],
		...(meta.model?.trim() ? { model: meta.model.trim() } : {}),
		...(meta.thinking?.trim() ? { thinking: meta.thinking.trim() } : {}),
		...(Number(meta.max_turns) > 0 ? { maxTurns: Number(meta.max_turns) } : {}),
		// 文件里没写 enabled 就当启用；写 false/0/off 才是关
		enabled: !/^(false|0|off|no)$/i.test((meta.enabled ?? "").trim()),
		builtin: false,
	};
}

function profileToMarkdown(profile: SubagentProfileSpec): string {
	const lines = ["---", `name: ${profile.id}`, `display_name: ${profile.label}`];
	lines.push(`description: ${profile.description.replace(/\n+/g, " ")}`);
	lines.push(`tools: ${profile.tools.join(", ")}`);
	if (profile.model) lines.push(`model: ${profile.model}`);
	if (profile.thinking) lines.push(`thinking: ${profile.thinking}`);
	if (profile.maxTurns) lines.push(`max_turns: ${profile.maxTurns}`);
	lines.push(`enabled: ${profile.enabled ? "true" : "false"}`, "---", "", profile.systemPrompt, "");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 读：内置 + 用户文件（同名覆盖内置）；settings.json 管启停与并发
// ---------------------------------------------------------------------------

function readSettingsFile(agentDir: string): Record<string, unknown> {
	const path = agentsSettingsPath(agentDir);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export function readSubagentSettings(agentDir: string): SubagentSettingsView {
	const own = readSettingsFile(agentDir)[SETTINGS_KEY];
	const record = typeof own === "object" && own !== null ? (own as Record<string, unknown>) : {};
	const concurrency = Number(record.concurrency);
	return {
		enabled: record.enabled !== false,
		concurrency: Number.isFinite(concurrency) ? Math.min(12, Math.max(1, Math.round(concurrency))) : 4,
	};
}

/** 用户模板（读目录里所有 *.md；坏文件跳过，不让一个写坏的 md 拖垮整个列表） */
function readUserProfiles(agentDir: string): SubagentProfileSpec[] {
	const dir = agentsDir(agentDir);
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".md"));
	} catch {
		return [];
	}
	const out: SubagentProfileSpec[] = [];
	for (const name of names.sort()) {
		try {
			const profile = profileFromFile(name, readFileSync(join(dir, name), "utf8"));
			if (profile) out.push(profile);
		} catch {
			// 读不动就当没有
		}
	}
	return out;
}

/**
 * 全部模板：内置那几个**保持原位**（哪怕用户改过、已经变成同名用户文件），
 * 其余用户模板按 id 排在后面 —— 「改了一个内置模板，它就跳到列表末尾」很容易让人以为丢了。
 */
function listSubagentProfiles(agentDir: string): SubagentProfileSpec[] {
	const byId = new Map(readUserProfiles(agentDir).map((profile) => [profile.id, profile]));
	const ordered: SubagentProfileSpec[] = [];
	for (const builtin of DEFAULTS) {
		const override = byId.get(builtin.id);
		ordered.push(override ?? builtin);
		byId.delete(builtin.id);
	}
	ordered.push(...[...byId.values()].sort((left, right) => left.id.localeCompare(right.id)));
	return ordered;
}

/** 面板视图（协议形状）：多一个「有文件的才能删」的隐含语义由 builtin 表达 */
export function listSubagentProfileViews(agentDir: string): SubagentProfileView[] {
	return listSubagentProfiles(agentDir).map((profile) => ({
		id: profile.id,
		label: profile.label,
		description: profile.description,
		systemPrompt: profile.systemPrompt,
		tools: [...profile.tools],
		...(profile.model ? { model: profile.model } : {}),
		...(profile.thinking ? { thinking: profile.thinking } : {}),
		...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
		enabled: profile.enabled,
		builtin: profile.builtin,
	}));
}

/** 引擎要的规格：只留启用的（停用的模板不会出现在 Agent 工具的描述里） */
export function enabledSubagentSpecs(agentDir: string): SubagentProfileSpec[] {
	return listSubagentProfiles(agentDir).filter((profile) => profile.enabled);
}

// ---------------------------------------------------------------------------
// 写：一个模板一个文件；settings.json 只改自己那个键（原子替换）
// ---------------------------------------------------------------------------

function writeFileAtomic(path: string, text: string): void {
	const temp = tempPathFor(path);
	writeFileSync(temp, text, { mode: 0o600 });
	renameSync(temp, path);
}

export function saveSubagentProfile(agentDir: string, input: SubagentProfileView): SubagentProfileSpec {
	const id = input.id.trim();
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw new Error("子代理 ID 只能用字母数字与 . _ -（≤64 字符）");
	const dir = agentsDir(agentDir);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const builtin = DEFAULTS.some((profile) => profile.id === id);
	// 内置模板没有自己的文件：直接保存等于「创建一个同名覆盖」—— 允许，但要有指令正文
	const systemPrompt = input.systemPrompt.trim();
	if (systemPrompt === "") throw new Error("系统指令不能为空");
	const tools = input.tools.filter((tool) => (SUBAGENT_TOOLS as readonly string[]).includes(tool));
	const profile: SubagentProfileSpec = {
		id,
		label: input.label.trim() || id,
		description: input.description.trim(),
		systemPrompt,
		tools: tools.length > 0 ? tools : ["read"],
		...(input.model?.trim() ? { model: input.model.trim() } : {}),
		...(input.thinking?.trim() ? { thinking: input.thinking.trim() } : {}),
		...(input.maxTurns && input.maxTurns > 0 ? { maxTurns: Math.min(200, Math.round(input.maxTurns)) } : {}),
		enabled: input.enabled,
		builtin,
	};
	writeFileAtomic(join(dir, `${id}.md`), profileToMarkdown(profile));
	return profile;
}

export function deleteSubagentProfile(agentDir: string, id: string): boolean {
	// 只删「有文件的」：内置模板没有文件，删了也无处可删 → 回一条能看懂的话。
	// 注意内置 id 若已被用户保存成同名文件，那就是有文件的，可以删（删掉等于恢复内置版本）。
	const path = join(agentsDir(agentDir), `${id}.md`);
	if (!existsSync(path)) {
		if (DEFAULTS.some((profile) => profile.id === id)) {
			throw new Error("内置模板没有可删的文件：可以停用，或改成一个自己的模板");
		}
		return false;
	}
	renameSync(path, `${path}.deleted-${Date.now()}`);
	return true;
}

export function writeSubagentSettings(agentDir: string, patch: Partial<SubagentSettingsView>): SubagentSettingsView {
	const dir = agentsDir(agentDir);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const current = readSettingsFile(agentDir);
	const own =
		typeof current[SETTINGS_KEY] === "object" && current[SETTINGS_KEY] !== null
			? (current[SETTINGS_KEY] as Record<string, unknown>)
			: {};
	const next = readSubagentSettings(agentDir);
	const merged = {
		...own,
		...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
		...(typeof patch.concurrency === "number" ? { concurrency: patch.concurrency } : {}),
	};
	const settings: SubagentSettingsView = {
		enabled: merged.enabled !== false,
		concurrency: Number.isFinite(Number(merged.concurrency))
			? Math.min(12, Math.max(1, Math.round(Number(merged.concurrency))))
			: next.concurrency,
	};
	writeFileAtomic(
		agentsSettingsPath(agentDir),
		`${JSON.stringify({ ...current, [SETTINGS_KEY]: { ...merged, ...settings } }, null, 2)}\n`,
	);
	return settings;
}
