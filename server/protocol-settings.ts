/**
 * 协议里「设置」这一组类型（从 protocol.ts 拆出：那边贴着 400 行上限）。
 * 仍然是**单源**：`server/protocol.ts` 只做重导出，web 侧照旧走 `web/src/types.ts` shim。
 */
/** 会话级偏好：置顶 / 归档 / 手动顺序（**不含重命名**：名字写在 pi 的会话文件里） */
export type SessionPrefs = {
	pinned: string[];
	archived: string[];
	/**
	 * 会话的显式顺序（会话 id 数组，与 `ProjectPrefs.order` 同语义）：
	 * 拖动互换位置后落盘。不在这个数组里的会话按创建时间倒序排在「有顺序的」之后。
	 */
	order: string[];
};

/** 项目偏好（ADR-0028）：显式顺序 + 置顶 + 显示名别名（身份仍是 cwd） */
export type ProjectPrefs = {
	order: string[];
	pinned: string[];
	aliases: Record<string, string>;
	/**
	 * 被用户「隐藏」的项目 cwd（右键菜单 → 隐藏项目）。
	 *
	 * 只是**侧栏不画它**，会话、别名、置顶、顺序全都原样留着 ——
	 * 取消隐藏（「已隐藏 · N」入口 / 刚隐藏时那条提示的「撤销」）就回来了。
	 */
	hidden: string[];
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

/**
 * 外观尺寸（ADR-0050）：聊天正文 / 侧栏项目名 / 侧栏会话名的**像素字号**。
 *
 * 为什么放进客户端设置（而不是像以前一样只存浏览器 localStorage）：
 * 只有服务端有一份，agent 才能在对话里改它 —— 用户说一句「对话文字设大一点」
 * 才有落点（走现有 `set_settings` RPC + 快照回推，不需要新接口）。
 * 浏览器那边仍以 localStorage 为第一来源（离线可用），服务端这份是共享权威副本。
 */
export type AppearanceView = {
	/** 聊天正文字号（2–30，双数） */
	chatPx: number;
	/** 侧栏项目名字号 */
	projectPx: number;
	/** 侧栏会话名字号 */
	sessionPx: number;
};

export type SettingsView = {
	quickPhrases: string[];
	/** @deprecated 仅老客户端兼容 / 一次性回落用，真正的显隐在本机偏好（见 `web/src/ui-prefs.ts`） */
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
	/**
	 * 外观字号（ADR-0050）：对话里说一句就能改，改完由快照回推给浏览器。
	 *
	 * `null` = **还没人显式设过**（老用户 / 新装的机器）：这时浏览器继续用本机 localStorage 里
	 * 那份字号，服务端不下发、也不把用户自己调过的值按回去。一旦 agent 或面板设过一次，
	 * 这里就不再是 null，之后以它为准（换设备也一致）。
	 */
	appearance: AppearanceView | null;
};
