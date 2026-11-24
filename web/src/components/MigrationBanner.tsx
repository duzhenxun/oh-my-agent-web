/**
 * 项目迁移提示条：这个仓库（oh-my-agent-web）已经不再往下演进，接手的是 pop-agent。
 *
 * 为什么挂在**顶栏下面、横贯整窗**的一整行（而不是底部 toast、也不是对话里的一条 notice）：
 *   1. toast 是「可撤销的瞬时动作」，几秒后自己消失，看完就没了；
 *      服务端的 notices 是「这一轮出了什么错」，跟会话绑定、也会过期。
 *      迁项目这件事两者都不像：它是**一次性的、说给所有人**的公告。
 *   2. 它必须在**任何页面状态**下都看得见：还没开会话、右侧面板铺开、手机单栏 —— 都不该漏。
 *      顶栏下面这条是全页最高、又不会盖住内容的可用位置。
 *   3. 它只该占一次地方：用户看过、点掉之后就存 localStorage，不再天天挡着。
 *      （存的是「点掉过」，不是「看过」：新设备 / 清了缓存会再提示一次，这是故意的。）
 *
 * 文案走 `t("中文", "English")`（这个项目的就地翻法，见 language.ts），
 * 不引 i18n key 表；链接地址是 `brand.ts` 的 MIGRATION_URL（和服务端那份对应，改地址两处一起改）。
 */
import { MIGRATION_URL } from "../brand.ts";
import { useT } from "../use-language.ts";
import { useStoredBool } from "../use-stored-bool.ts";

/** 点掉之后记住的键（`agent-web.` 前缀与本项目其它本机偏好一致） */
const DISMISSED_KEY = "agent-web.migration.dismissed";

export function MigrationBanner() {
	const t = useT();
	const [dismissed, setDismissed] = useStoredBool(DISMISSED_KEY, false);
	if (dismissed) return null;
	return (
		<div className="migration-bar" role="status">
			<span className="migration-bar-text">
				{t("🚀 本项目已升级，请改用新项目继续使用：", "🚀 This project has been upgraded — please use the new one:")}
				<a className="migration-bar-link" href={MIGRATION_URL} target="_blank" rel="noreferrer noopener">
					duzhenxun/pop-agent
				</a>
			</span>
			{/* 「不再提示」做得轻（透明底、灰字）：它是个次要动作，别和链接抢注意力 */}
			<button
				type="button"
				className="migration-bar-close"
				onClick={() => setDismissed(true)}
				title={t("不再显示这条提示", "Don't show this again")}
			>
				✕ {t("不再提示", "Dismiss")}
			</button>
		</div>
	);
}
