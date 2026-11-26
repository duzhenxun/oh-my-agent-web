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
	/**
	 * 内置项的**第二份：英文**（2026-11-23 用户：「这个如果是英文得自动显示英文的」）。
	 *
	 * 为什么存在数据里而不是界面里翻：模板正文是要被插进输入框的**内容**，
	 * 不是界面文案 —— 英文界面下应当插入英文提示词，而不只是把标题翻掉。
	 * 由服务端在归一化时补上（见 `session/settings.ts` 的 `normalizeTemplates`）：
	 * **只有原文还等于内置原文时才补**，用户改过的模板不会被塞一份过时的译文。
	 * 缺省 = 没有英文副本，界面就用存下来的原文。
	 */
	nameEn?: string;
	descriptionEn?: string;
	textEn?: string;
};

/**
 * 快捷指令（输入框上方 / 提示词弹窗里那排胶囊）：同样是**存两份**。
 *
 * `text` 是中文原文（也是身份的判定依据），`textEn` 是英文副本。
 * 老版本存的是纯字符串数组 —— `normalizeQuickPhrases` 会认，并给「还是内置原文」的那几条
 * 自动补上英文（与内置模板同一条规则）。用户自己写的短语没有英文副本，两种语言下都原样显示。
 */
export type QuickPhrase = {
	text: string;
	textEn?: string;
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
	quickPhrases: QuickPhrase[];
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
