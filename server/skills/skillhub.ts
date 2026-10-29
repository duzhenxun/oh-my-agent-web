/**
 * SkillHub（skillhub.tencent.com / api.skillhub.cn）技能市场。
 *
 * 接口与下载都走同一套 HTTP API，这里只保留 oh-my-agent-web 需要的部分，并补上几个细节：
 *
 *   - **列表**：`GET https://api.skillhub.cn/api/skills?page=&pageSize=&sortBy=score&order=desc&keyword=&category=`
 *     返回 `{ code, data: { skills: [...], total } }`；字段名很花（`name`/`slug`/`namespace`/
 *     `ownerName`/`downloads`/`stars`/`description_zh`…），这里统一收敛成一个结构。
 *   - **下载**：`GET https://api.skillhub.cn/api/v1/download?slug=<slug>` → 一个 zip，
 *     `SKILL.md` 一般在根目录，也可能套一层目录。
 *   - **分类**：接口不给分类清单，前端写死 8 个 key（截图里那排就是它们）。
 *
 * 缓存：搜索结果在进程内存里放 5 分钟（同参数直接命中）。技能库首页是「打开面板就看」，
 * 每次翻面板都打一次外网既慢又没必要。
 */
import { extractZip, skillRootOf } from "./zip.js";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "https://api.skillhub.cn";
const SEARCH_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 20_000;

/** 分类清单：与 SkillHub 前端的 key 一致（接口不返回分类表） */
export const HUB_CATEGORIES: { key: string; label: string }[] = [
	{ key: "", label: "全部" },
	{ key: "ai-intelligence", label: "AI 智能" },
	{ key: "developer-tools", label: "开发工具" },
	{ key: "productivity", label: "效率提升" },
	{ key: "data-analysis", label: "数据分析" },
	{ key: "content-creation", label: "内容创作" },
	{ key: "security-compliance", label: "安全合规" },
	{ key: "communication-collaboration", label: "通讯协作" },
];

export type HubSkill = {
	/** 下载用的 slug（`dev-god`） */
	slug: string;
	name: string;
	/** 作者（SkillHub 的 handle） */
	author?: string;
	description: string;
	category?: string;
	categoryLabel?: string;
	/** 下载量 */
	downloads?: number;
	/** 收藏 / star */
	stars?: number;
	version?: string;
	homepage?: string;
	iconUrl?: string;
	/** 来源（enterprise / community / github…） */
	source?: string;
	verified?: boolean;
};

type HubSearchResult = {
	skills: HubSkill[];
	page: number;
	pageSize: number;
	total?: number;
	hasMore: boolean;
};

type CacheEntry = { at: number; result: HubSearchResult };

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * 条目自己带的分类（`dev-programming` 这种）跟筛选用的 key 是**两套词表**：
 * 筛选那 8 个 key 是 SkillHub 前端的侧栏分类（接口会做别名映射，实测每个 key 命中数不同），
 * 条目上的 `category` 则是更细的 12 类。两套都要有中文名，否则卡片上会直接露英文 key。
 */
const ITEM_CATEGORY_LABELS: Record<string, string> = {
	"dev-programming": "开发编程",
	"knowledge-management": "知识管理",
	"life-service": "生活服务",
	"office-efficiency": "办公效率",
	"design-media": "设计媒体",
	professional: "专业服务",
	education: "教育学习",
	"content-creation": "内容创作",
	"data-analysis": "数据分析",
	"ai-agent": "AI 智能体",
	"business-ops": "商业运营",
	"it-ops-security": "IT 运维安全",
};

function categoryLabel(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	return ITEM_CATEGORY_LABELS[key] ?? HUB_CATEGORIES.find((item) => item.key === key)?.label ?? key;
}

/** 一条原始记录 → HubSkill（字段名各家不一，按优先级取第一个非空的） */
function toHubSkill(raw: Record<string, unknown>): HubSkill | null {
	const slug = str(raw.slug) ?? str(raw.id);
	const name = str(raw.name) ?? str(raw.title);
	if (slug === undefined || name === undefined) return null;
	const namespace = record(raw.namespace);
	const category = str(raw.category);
	return {
		slug,
		name,
		...((str(raw.ownerName) ?? str(namespace?.handle) ?? str(raw.upstream_owner_login))
			? { author: str(raw.ownerName) ?? str(namespace?.handle) ?? str(raw.upstream_owner_login) }
			: {}),
		description: str(raw.description_zh) ?? str(raw.description) ?? str(raw.summary) ?? "",
		...(category === undefined ? {} : { category, categoryLabel: categoryLabel(category) }),
		...(num(raw.downloads) === undefined ? {} : { downloads: num(raw.downloads) }),
		...(num(raw.stars) === undefined ? {} : { stars: num(raw.stars) }),
		...(str(raw.version) === undefined ? {} : { version: str(raw.version) }),
		...(str(raw.homepage) === undefined ? {} : { homepage: str(raw.homepage) }),
		...(str(raw.iconUrl) === undefined ? {} : { iconUrl: str(raw.iconUrl) }),
		...(str(raw.source) === undefined ? {} : { source: str(raw.source) }),
		...(raw.verified === true ? { verified: true } : {}),
	};
}

export type SkillHub = {
	search: (input: {
		query?: string;
		category?: string;
		page?: number;
		pageSize?: number;
		refresh?: boolean;
	}) => Promise<HubSearchResult>;
	/** 下载技能包到临时目录，返回「含 SKILL.md 的那一层」的绝对路径与清理函数 */
	fetchPackage: (slug: string) => Promise<{ dir: string; cleanup: () => Promise<void> }>;
};

export function createSkillHub(options: { fetchImpl?: typeof fetch } = {}): SkillHub {
	const fetchImpl = options.fetchImpl ?? fetch;
	const cache = new Map<string, CacheEntry>();

	return {
		async search(input) {
			const page = Math.max(1, Math.floor(input.page ?? 1));
			const pageSize = Math.max(1, Math.min(50, Math.floor(input.pageSize ?? 24)));
			const query = (input.query ?? "").trim();
			const category = (input.category ?? "").trim();
			const key = `${query}\0${category}\0${page}\0${pageSize}`;
			const hit = cache.get(key);
			if (input.refresh !== true && hit !== undefined && Date.now() - hit.at < SEARCH_TTL_MS) return hit.result;

			const url = new URL(`${BASE}/api/skills`);
			url.searchParams.set("page", String(page));
			url.searchParams.set("pageSize", String(pageSize));
			url.searchParams.set("sortBy", "score");
			url.searchParams.set("order", "desc");
			if (query !== "") url.searchParams.set("keyword", query);
			if (category !== "") url.searchParams.set("category", category);

			const response = await fetchImpl(url.toString(), {
				headers: { accept: "application/json", "user-agent": "oh-my-agent-web" },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`SkillHub 返回 HTTP ${response.status}`);
			const payload = (await response.json()) as unknown;
			const data = record(record(payload)?.data);
			const list = Array.isArray(data?.skills) ? data.skills : [];
			const seen = new Set<string>();
			const skills: HubSkill[] = [];
			for (const item of list) {
				const recordItem = record(item);
				if (recordItem === null) continue;
				const skill = toHubSkill(recordItem);
				// SkillHub 同一个技能会出现多条（不同版本/命名空间）：按 slug 只留第一条，
				// 否则界面里同一个技能排两遍，React 的 key 还会撞（重复 key 的渲染结果不可控）
				if (skill === null || seen.has(skill.slug)) continue;
				seen.add(skill.slug);
				skills.push(skill);
			}
			const total = num(data?.total);
			const result: HubSearchResult = {
				skills,
				page,
				pageSize,
				...(total === undefined ? {} : { total }),
				hasMore: total === undefined ? skills.length === pageSize : page * pageSize < total,
			};
			cache.set(key, { at: Date.now(), result });
			return result;
		},

		async fetchPackage(slug) {
			const response = await fetchImpl(`${BASE}/api/v1/download?slug=${encodeURIComponent(slug)}`, {
				headers: { accept: "application/zip", "user-agent": "oh-my-agent-web" },
				signal: AbortSignal.timeout(60_000),
			});
			if (!response.ok) {
				// 4xx 基本都是对面仓库里没有这一版的包（实测有技能 302 到 COS 后 404），
				// 不是我们的参数错了 —— 把话说清楚，别让人去查自己的配置
				throw new Error(
					response.status === 404
						? "下载技能包失败：对方仓库里这一版的包不存在（SkillHub 数据问题，换一个技能或稍后再试）"
						: `下载技能包失败（HTTP ${response.status}）`,
				);
			}
			const buffer = Buffer.from(await response.arrayBuffer());
			const workDir = await mkdtemp(join(tmpdir(), "oh-my-agent-web-skill-"));
			const cleanup = () => rm(workDir, { recursive: true, force: true }).catch(() => undefined);
			try {
				const files = await extractZip(buffer, workDir);
				const sub = skillRootOf(files);
				if (sub === null) throw new Error("技能包里没有 SKILL.md");
				const dir = sub === "" ? workDir : join(workDir, sub);
				await stat(join(dir, "SKILL.md"));
				return { dir, cleanup };
			} catch (error) {
				await cleanup();
				throw error;
			}
		},
	};
}

/** 干净的技能目录名：只留字母数字与 `-_.`，并去掉开头那个点 */
export function safeSkillDirName(raw: string): string {
	const cleaned = raw
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^\.+/, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned === "" ? "skill" : cleaned.slice(0, 80);
}

/** 目录里是不是一个技能（有 SKILL.md 或 .SKILL.md.disabled） */
export async function hasSkillFile(dir: string): Promise<boolean> {
	for (const name of ["SKILL.md", ".SKILL.md.disabled"]) {
		const ok = await stat(join(dir, name))
			.then((info) => info.isFile())
			.catch(() => false);
		if (ok) return true;
	}
	return false;
}

/** 列一个目录下所有「是技能」的子目录名 */
export async function listSkillDirs(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const names: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (await hasSkillFile(join(root, entry.name))) names.push(entry.name);
	}
	return names.sort();
}
