/**
 * 产品在界面上的自称（顶栏、欢迎页、通知、标签页标题都用它）。
 * 集中一处：名字改一次就够，避免四处各写一份又漂移。
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
