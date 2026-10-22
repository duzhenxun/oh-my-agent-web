/**
 * 协议里「设置」这一组类型（从 protocol.ts 拆出：那边贴着 400 行上限）。
 * 仍然是**单源**：`server/protocol.ts` 只做重导出，web 侧照旧走 `web/src/types.ts` shim。
 */
/** 会话级偏好：置顶 / 归档（**不含重命名**：名字写在 pi 的会话文件里） */
export type SessionPrefs = {
	pinned: string[];
	archived: string[];
};

/** 项目偏好（ADR-0028）：显式顺序 + 置顶 + 显示名别名（身份仍是 cwd） */
export type ProjectPrefs = {
	order: string[];
	pinned: string[];
	aliases: Record<string, string>;
};

/** 提示词模板（P5）：一个模板 = 名字 + 一句说明 + 图标 + 正文 */
export type PromptTemplate = {
	id: string;
	name: string;
	description: string;
	icon: string;
	text: string;
	/** 软删除（P5）：内置模板「移出模板库」只隐藏，恢复默认模板即可复原 */
	hidden?: boolean;
};

export type SettingsView = {
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
	/** 提示词模板库（P5）：点卡片直接填进输入框；可增删改、可恢复默认 */
	templates: PromptTemplate[];
	/** 项目排序 / 置顶 / 别名（ADR-0028） */
	projectPrefs: ProjectPrefs;
	/** 会话级偏好：置顶 / 重命名 / 归档（本轮新增） */
	sessionPrefs: SessionPrefs;
	/** 每个项目的默认模型（workspace 绝对路径 → `provider/model`）：新会话按它起步 */
	defaultModels: Record<string, string>;
	/** 「想想」一次生成几条下一步建议（1–8） */
	thinkCount: number;
	/** 「想想」最多等多久（秒，5–180）：超时就中断那个隐藏回合 */
	thinkTimeoutSec: number;
};
