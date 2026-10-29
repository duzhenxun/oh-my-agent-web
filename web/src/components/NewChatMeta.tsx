import { REPO_URL, UPGRADE_COMMAND } from "../brand.ts";
import { useT } from "../use-language.ts";
import { useBrandName } from "../use-brand-name.ts";
/**
 * 新会话（还没有消息时）抬头：图标 + 名字 + 版本号 + 一句招呼，紧贴输入框上方。
 *
 * 为什么放这儿而不是放大片空白里：这是「准备开聊」的那一刻，人要看的信息就这几样 ——
 * 「这是哪个工具」「什么版本」「现在能干什么」。放在输入框上方，视线不用来回跑；
 * 消息一多这行就自动消失（不长期占地方）。
 *
 * 排版：左图右文（名字大字、版本号小字）；招呼语不在这里 —— 它居中放在对话区
 * （见 App.tsx 的 `.chat-greeting`）。
 *
 * 「开源项目」是链接（新标签打开仓库）、后面跟产品版本号；引擎自身的版本这里不显示
 * （引擎名/版本在顶栏的引擎选择器里看，见 EnginePicker）。
 */
export function NewChatMeta({
	webVersion,
	latestVersion,
	outdated,
	onUpgrade,
}: {
	webVersion: string;
	/** 上游（GitHub）最新版本；查不到为 null */
	latestVersion: string | null;
	/** 上游比本机新 → 版本号后面多一个小角标「↑ 有新版」（结论由服务端给，界面不自己比版本号） */
	outdated: boolean;
	/**
	 * 点「↑ 有新版」干什么：调起右侧终端并把升级命令敲进去（App 传进来）。
	 * 不传就退化成纯展示（角度仍可见，但不是按钮）。
	 */
	onUpgrade?: () => void;
}) {
	// 文案全部走 `t()`：这一块是「还没开聊时的门面」，英文界面下不能只剩中文
	const t = useT();
	// 抬头用同一个自称：设置 → 外观 里改过名，这里跟着改（隐藏只管顶栏，这里照旧显示）
	// logo 同理：换过就跟着换；「是否显示」只管顶栏那一处，抬头这里照旧显示（跟名字同一个口径）
	const { name: brandName, logo: brandLogo } = useBrandName();
	return (
		<div className="newchat-meta">
			<div className="newchat-brand">
				<img className="newchat-icon" src={brandLogo || "/favicon.svg"} alt="" aria-hidden="true" />
				<div className="newchat-brand-text">
					<span className="newchat-name">{brandName}</span>
					<span className="newchat-versions mono">
						{/* 「开源项目」本身是「去仓库看更新」的入口（新标签打开）：点它才好看 changelog / 提 issue
						    英文里这条链接就叫 GitHub（见 i18n-en.ts），不直译「开源项目」 */}
						<a
							className="newchat-version-link"
							href={REPO_URL}
							target="_blank"
							rel="noreferrer"
							title={
								outdated && latestVersion
									? t(
											`上游已发布 v${latestVersion}（本机 v${webVersion}）· 点这里去仓库看更新日志`,
											`Upstream released v${latestVersion} (you are on v${webVersion}) · open the repo for the changelog`,
										)
									: t(`${REPO_URL}（点这里看更新日志 / 提 issue）`, `${REPO_URL} (changelog / issues)`)
							}
						>
							{t("开源项目")}
						</a>
						{` v${webVersion}`}
						{/* 有新版本时多一个小胶囊：点它 = 开终端并把升级命令敲进去（不用人复制粘贴）。
						    必须是按钮且**不能嵌在 <a> 里** —— 否则点安装会同时跳去仓库 */}
						{outdated ? (
							<button
								type="button"
								className="newchat-version-badge"
								disabled={!onUpgrade}
								onClick={onUpgrade}
								title={
									onUpgrade
										? t(
												`在终端里执行 ${UPGRADE_COMMAND}（回车自动敲）`,
												`Runs ${UPGRADE_COMMAND} in a terminal (auto-submitted)`,
											)
										: t(
												`上游已发布 v${latestVersion ?? ""}，本机 v${webVersion}`,
												`Upstream released v${latestVersion ?? ""}, you are on v${webVersion}`,
											)
								}
							>
								{t("↑ 有新版")}
								{onUpgrade ? ` · ${t("点此升级")}` : ""}
							</button>
						) : null}
					</span>
				</div>
			</div>
		</div>
	);
}
