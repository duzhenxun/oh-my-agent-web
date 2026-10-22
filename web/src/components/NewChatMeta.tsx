import { BRAND_NAME, REPO_URL } from "../brand.ts";
/**
 * 新会话（还没有消息时）抬头：图标 + 名字 + 版本号 + 一句招呼，紧贴输入框上方。
 *
 * 为什么放这儿而不是放大片空白里：这是「准备开聊」的那一刻，人要看的信息就这几样 ——
 * 「这是哪个工具」「什么版本」「现在能干什么」。放在输入框上方，视线不用来回跑；
 * 消息一多这行就自动消失（不长期占地方）。
 *
 * 排版：左图右文（名字大字、版本号小字）；招呼语不在这里 —— 它居中放在对话区
 * （见 App.tsx 的 `.chat-greeting`）。
 */
export function NewChatMeta({
	webVersion,
	engineName,
	engineVersion,
	latestVersion,
	outdated,
}: {
	webVersion: string;
	/** 引擎名：`pi` / `fake` */
	engineName: string;
	engineVersion: string | null;
	/** 上游（GitHub）最新版本；查不到为 null */
	latestVersion: string | null;
	/** 上游比本机新 → 版本号后面多一个小角标「↑ 有新版」（结论由服务端给，界面不自己比版本号） */
	outdated: boolean;
}) {
	return (
		<div className="newchat-meta">
			<div className="newchat-brand">
				<img className="newchat-icon" src="/favicon.svg" alt="" aria-hidden="true" />
				<div className="newchat-brand-text">
					<span className="newchat-name">{BRAND_NAME}</span>
					<span className="newchat-versions mono">
						{/* 版本号本身就是「去仓库看更新」的入口：点了才好看 changelog / 提 issue */}
						<a
							className="newchat-version-link"
							href={REPO_URL}
							target="_blank"
							rel="noreferrer"
							title={
								outdated && latestVersion
									? `上游已发布 v${latestVersion}（本机 v${webVersion}）· 点这里去仓库更新`
									: `${REPO_URL}（点这里看更新日志 / 提 issue）`
							}
						>
							{`web v${webVersion}`}
							{/* 只在有新版本时多一个小角标：版本号本身保持原样，不抢眼也不改字号 */}
							{outdated ? <span className="newchat-version-badge">↑ 有新版</span> : null}
						</a>
						{` · ${engineName}${engineVersion ? ` v${engineVersion}` : ""}`}
					</span>
				</div>
			</div>
		</div>
	);
}
