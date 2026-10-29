/**
 * 产品在界面上的自称（顶栏、欢迎页、通知、标签页标题都用它）。
 * 集中一处：名字改一次就够，避免四处各写一份又漂移。
 *
 * 这是**产品名**，不是用户在设置里起的名字：顶栏与标签页的显示名可以被
 * `brand-name.ts`（设置 → 外观）覆盖 / 隐藏，服务端登录框与推送标题仍用这里的真名。
 */
export const BRAND_NAME = "oh-my-agent-web";

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
