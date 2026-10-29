/**
 * 技能面板的数据形状与几个纯函数。
 *
 * 单独放一个文件（跟 mcp-view.ts 同一套理由）：面板与「安装」几个子页都要认这些类型，
 * 放谁那儿都会变成「从兄弟组件里 import 类型」。
 */

/** 已安装的一个技能（服务端 `GET /api/skills` 的形状） */
export type Skill = {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	/** 目录内的相对路径（最多 200 条） */
	files: string[];
};

/** 技能市场（SkillHub）的一条 */
export type HubSkill = {
	slug: string;
	name: string;
	author?: string;
	description: string;
	category?: string;
	categoryLabel?: string;
	downloads?: number;
	stars?: number;
	version?: string;
	homepage?: string;
	source?: string;
	verified?: boolean;
	/** 本机是不是已经装了同名的（服务端按目录名比） */
	installed?: boolean;
};

type HubCategory = { key: string; label: string };

export type HubPage = {
	skills?: HubSkill[];
	categories?: HubCategory[];
	page?: number;
	hasMore?: boolean;
	total?: number;
	error?: string | { message?: string };
};

/** 安装类接口统一的返回：提示 + 新列表（有 skills 就顺手刷新，不用再打一次） */
export type InstallResponse = {
	notice?: string;
	installError?: string;
	skills?: Skill[];
	/** git 两段式的第一步：仓库里有哪些技能 */
	ok?: boolean;
	error?: string;
};

/** 技能里某个文件的内容（`GET /api/skills/:id/file`） */
export type Preview = { text: string; bytes: number; binary: boolean };

export function errorText(body: { error?: string | { message?: string } }, status: number): string {
	if (typeof body.error === "string") return body.error;
	return body.error?.message ?? `HTTP ${status}`;
}

/** 千分位：下载量 8010617 → 8,010,617 */
export function withThousands(value: number): string {
	return value.toLocaleString("zh-CN");
}

/** 搜索：名字、描述、目录名任一命中（本地过滤，几十个技能不必打服务端） */
export function filterInstalled(skills: Skill[], query: string): Skill[] {
	const q = query.trim().toLowerCase();
	if (q === "") return skills;
	const words = q.split(/\s+/);
	return skills.filter((skill) => {
		const haystack = `${skill.name} ${skill.id} ${skill.description}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

/** 文件列表排序：SKILL.md 永远第一，其余按路径（点开时默认看 SKILL.md） */
export function sortedFiles(files: string[]): string[] {
	return [...files].sort((left, right) => {
		const rank = (file: string) => (/^skill\.md$/i.test(file) ? 0 : /^references\//i.test(file) ? 2 : 1);
		return rank(left) - rank(right) || left.localeCompare(right);
	});
}
