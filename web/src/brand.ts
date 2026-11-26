/**
 * 产品在界面上的自称（顶栏、欢迎页、通知、标签页标题都用它）。
 * 集中一处：名字改一次就够，避免四处各写一份又漂移。
 *
 * 这是**产品名**，不是用户在设置里起的名字：顶栏与标签页的显示名可以被
 * `brand-name.ts`（设置 → 外观）覆盖 / 隐藏，服务端登录框与推送标题仍用这里的真名。
 */
export const BRAND_NAME = "oh-my-agent-web";

/**
 * 默认自称跟着**当前引擎**走（用户 2026-11-24：「我用 Pi 就显示 PiAgent」）。
 *
 * 「哪个引擎」默认用的是引擎选择器里那个**蓝色短标签**（badge：PI / CODEX / DSH / OC），
 * 所以名字从 badge 派生（OC → OcAgent），跟面板里看到的字母一致。
 *
 * 但 **claude 是例外**（用户 2026-11-24：「里面的 cc 改成 Claude」）：
 * 它的 badge 是 CC，而 CC 本身不是任何一个字（只是首字母），顶栏写 CcAgent 没人看得懂 ——
 * 所以这张表**优先于 badge**：表里有的按表，表里没有的才用 badge 派生。
 */
const ENGINE_BRAND_NAMES: Record<string, string> = {
	pi: "PiAgent",
	codex: "CodexAgent",
	opencode: "OcAgent",
	dsh: "DshAgent",
	claude: "ClaudeAgent",
};

/** `CODEX` → `Codex`、`OC` → `Oc`（其余字母小写，避免 OCAgent 这种全大写的怪名字） */
function titleCaseBadge(badge: string): string {
	const lower = badge.trim().toLowerCase();
	return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * 引擎 → 默认自称：**先查表**（claude 这种 badge 不够用的在这里写全名），
 * 表里没有的新引擎才用快照里的 badge 派生（OC → OcAgent），都没有就回落产品名。
 */
export function engineBrandName(engine: string | null | undefined, badge?: string | null): string {
	if (!engine) return BRAND_NAME;
	const known = ENGINE_BRAND_NAMES[engine];
	if (known) return known;
	const trimmed = badge?.trim();
	if (trimmed) return `${titleCaseBadge(trimmed)}Agent`;
	return BRAND_NAME;
}

/**
 * 仓库地址（新会话抬头的版本号指向它：更新日志 / 提 issue 都在那儿）。
 *
 * 为什么不直接从 `server/util/upstream-version.ts` import：web 只允许通过
 * `web/src/types.ts` 这个 shim 碰 server 的**协议类型**（ADR-0002 纪律①）。
 * 一个 URL 常量不值得开这个口子 —— 改仓库时这两处一起改。
 */
export const REPO_URL = "https://github.com/duzhenxun/oh-my-agent-web";

/**
 * 升级命令：抬头「↑ 有新版」点一下，就在终端里**自动敲这一行并回车**（不用人复制粘贴）。
 *
 * 跟 `aw upgrade`（server/cli-info.ts）装的是同一个东西 —— 那边是 `npm install -g <name>@latest`，
 * 这边写成全名是为了让用户在终端里看得懂自己在跑什么。改包名时两处一起改。
 */
export const UPGRADE_COMMAND = "npm -g install oh-my-agent-web@latest";
