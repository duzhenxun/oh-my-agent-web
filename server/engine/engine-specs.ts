/**
 * 各引擎「认哪个命令、缺了怎么说」—— ADR-0052。
 *
 * 一条硬规矩：**用户机器上已有的东西只读不改**。
 *
 * 缺的那份怎么来，经过三次收敛（2026-11-23）：
 *   1. 先是想「缺了自动装进私有目录」→ 否掉：那是偷偷往用户机器上塞东西；
 *   2. 再改成「只给文字引导，让用户自己去装」→ 不够：用户不想开终端；
 *   3. 最终（当前实现）：**界面上给一个按钮，用户点了我们才装** —— 装到他自己的
 *      npm prefix（与 `scripts/install.sh` 同一个：`~/.oh-my-agent-web`，不碰系统全局、不用 sudo）。
 *
 * 所以本文件里 `packages` / `guide` 都有了：`packages` 是「用户点了安装时跑什么」，
 * `guide` 是「不想点按钮、想自己装时跑什么」。两者都不是自动行为。
 *
 * 用户 2026-11-23：
 * > 如果用户电脑里有 codex claude 这些……不能动用户的。咱们只是一个壳，可以用他们的，但不能改人家的软件。
 * > 缺了也不能装到私有目录中。
 *
 * 所以这个工作台对第三方引擎只做两件事：
 *   1. **检测**：按 PATH（以及各自的 `AGENT_WEB_*_BIN`）看有没有，有就用他的那一份；
 *   2. **说实话**：没有就明确说「没找到 + 我们不装 + 你自己装好后就能用」。
 *
 * 不做的三件事（写清楚，免得以后有人「顺手加一下」）：
 *   - 不跑 `npm i -g`（会改用户全局环境）；
 *   - 不往 `<dataDir>/engines` 之类的地方装（那也是往用户机器上塞东西）；
 *   - 不改引擎自己的配置 / 升级它的版本 —— 我们只是调用它。
 *
 * 唯一「自带」的引擎是 pi：它是本项目的依赖，随工作台一起发（不是第三方安装）。
 * 这个文件只有纯数据与文案，能被纯映射模块直接引。
 */
/** 第三方引擎（可切换、可能要装） */
export type EngineKey = "codex" | "dsh" | "opencode" | "claude";
/** 全部引擎：pi 是默认那个，也在同一个「缺了就装」的机制里（ADR-0052 §4） */
export type AnyEngineKey = "pi" | EngineKey;

export type EngineSpec = {
	label: string;
	/** 认哪些命令（第一个是首选；claude 的 ACP 适配器改过名，两个都得认） */
	bins: string[];
	/** 指向可执行文件的逃生阀环境变量（文案里要告诉人） */
	binEnv: string;
	/**
	 * 用户点「安装」时装哪个 npm 包（按顺序试，第一个成功就停）。
	 * **只有用户点了按钮才会跑**，装进 `<dataDir>` 这个 npm prefix（见 engine-install.ts）。
	 */
	packages: string[];
	/**
	 * 安装引导：**给用户看的**，不是我们要执行的动作（ADR-0052）。
	 * 每条都是用户自己去终端里跑的命令 / 自己的安装渠道。
	 */
	guide: string[];
	/** 光装它还不足以跑起来的部分（Claude 的适配器只是个壳，本体得另装并登录） */
	afterInstall?: string;
	/**
	 * true = 这个引擎是**以模块**被工作台使用的（pi 走 SDK，进程内跑），不是靠 PATH 找命令。
	 * 判「装没装」时不能查 PATH，要查模块能不能解析出来。
	 */
	inProcess?: boolean;
};

export const ENGINE_SPECS: Record<AnyEngineKey, EngineSpec> = {
	pi: {
		label: "Pi Agent",
		bins: ["pi"],
		binEnv: "AGENT_WEB_PI_BIN",
		packages: ["@earendil-works/pi-coding-agent"],
		guide: ["npm i -g --prefix ~/.oh-my-agent-web @earendil-works/pi-coding-agent"],
		inProcess: true,
	},
	codex: {
		label: "Codex",
		bins: ["codex"],
		binEnv: "AGENT_WEB_CODEX_BIN",
		packages: ["@openai/codex"],
		guide: ["npm i -g @openai/codex（或按 Codex 官方文档用它的安装方式）"],
	},
	dsh: {
		label: "DeepSeek Harness",
		bins: ["dsh"],
		binEnv: "AGENT_WEB_DSH_BIN",
		// 没有公开的 npm 包：界面上不给「安装」按钮，只给去向
		packages: [],
		guide: ["按 DeepSeek Harness 自己的文档安装（它没有公开的 npm 包）"],
	},
	opencode: {
		label: "opencode",
		bins: ["opencode"],
		binEnv: "AGENT_WEB_OPENCODE_BIN",
		packages: ["opencode-ai"],
		guide: ["npm i -g opencode-ai（或用它官方的安装脚本）"],
	},
	claude: {
		label: "Claude Code",
		bins: ["claude-code-acp", "claude-agent-acp"],
		binEnv: "AGENT_WEB_CLAUDE_BIN",
		packages: ["@agentclientprotocol/claude-agent-acp", "@zed-industries/claude-code-acp"],
		// 适配器改过名：新名在前、旧名在后，两个都写给人看
		guide: ["npm i -g @agentclientprotocol/claude-agent-acp（旧名 @zed-industries/claude-code-acp）"],
		afterInstall: "Claude Code 本体（`claude`）也要装好并登录一次，适配器只是它的 ACP 外壳",
	},
};

export const ENGINE_KEYS: EngineKey[] = ["codex", "dsh", "opencode", "claude"];

export function isEngineKey(value: string): value is EngineKey {
	return (ENGINE_KEYS as string[]).includes(value);
}

/**
 * 「缺了这个引擎」该怎么说。
 *
 * 为什么要统一一份：这句话以前散在 `claude-map.ts` / `opencode-map.ts` 里，各自写死
 * 「先 `npm i -g xxx`」—— 那是在**指挥用户改自己的环境**，而且装了 App 的机器上
 * 未必有全局 npm，照着敲只会更困惑。现在统一成三段：没找到 → 我们不装也不改你的环境 →
 * 你自己装的话怎么做（具体命令 + 逃生阀）。
 */
export function missingEngineMessage(engine: EngineKey): string {
	const spec = ENGINE_SPECS[engine];
	const bins = spec.bins.join(" / ");
	const parts = [
		`没有找到 ${bins}：这台机器上没有 ${spec.label}`,
		`在引擎切换面板里点「安装」即可（装到 ~/.oh-my-agent-web，你自己的 npm 目录：不碰系统、不用 sudo）`,
		`也可以你自己装：${spec.guide.join("；")}（装好后 PATH 里能找到 ${spec.bins[0]} 就行），或设 ${spec.binEnv} 指向它`,
	];
	if (spec.afterInstall) parts.push(spec.afterInstall);
	return parts.join("。");
}
