import { startNewSession } from "../store.ts";
import { useT } from "../use-language.ts";

/**
 * 「新会话」那颗胶囊 —— **同一个动作，两处落点，任一时刻只画一颗**：
 *
 *  - 平时 → **侧栏最上面那条**（`.sidebar-brand`，品牌旁边，`variant="sidebar"`，见 Sidebar.tsx）；
 *  - 侧栏收起时 → 顶栏左段（`.appbar-side`，`variant="appbar"`，见 App.tsx）——
 *    那时整个 Sidebar 不挂载，只能回顶栏。两处的显隐靠 CSS（`.app:not(.app-collapsed) .appbar-side`）。
 *
 * 位置换过好几次，理由记在这儿：
 *  1. 最早在顶栏最左边，占着黄金位置，却跟右边的模型/设置那排抢宽度；
 *  2. 后来挪到侧栏「项目」头上（跟项目/会话列表同一件事，头上一句话就能新建）；
 *  3. 再后来只留顶栏那一颗 —— 理由是侧栏一收起 / 抽屉一关它就够不着了；
 *  4. 曾经又改成「两处都有、按侧栏开合分工」，结果展开时在「项目」旁边、收起来就跑到顶上，
 *     用户报的就是这个「按钮自己跑了」；
 *  5. 2026-11-23 用户定下现在的样子：**跟品牌一起放进侧栏最上面**（「这2块放到项管理里上面就行」），
 *     侧栏收起时回顶栏。两处仍是同一动作、同一时刻只有一颗。
 *
 * 「临时会话」（在右侧另开一条、不落盘）**不在这颗里**：它是另一个动作
 * （不换主对话），所以在**顶栏**右边那排入口里单独一颗，钉在「技能」左边，见 `TempChatButton.tsx`。
 */
export function NewChatButton({ variant = "appbar" }: { variant?: "appbar" | "sidebar" | "icon" }) {
	const t = useT();
	if (variant === "icon") {
		// 侧栏收起时顶栏那颗：只要一个小方块图标（用户 2026-11-23「只加一个新会话的小图就可以了」）
		return (
			<button
				type="button"
				className="newchat-icon-btn"
				onClick={() => startNewSession()}
				title={t("新建会话", "New session")}
				aria-label={t("新建会话", "New session")}
			>
				<span aria-hidden="true">💬</span>
			</button>
		);
	}
	return (
		<button
			type="button"
			className={`newchat-pill newchat-pill-${variant}`}
			onClick={() => startNewSession()}
			title={t("新建会话", "New session")}
		>
			<span className="newchat-pill-icon" aria-hidden="true">
				💬
			</span>
			<span className="newchat-pill-label">{t("新会话", "New session")}</span>
		</button>
	);
}
