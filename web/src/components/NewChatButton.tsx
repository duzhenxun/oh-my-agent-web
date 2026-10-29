import { startNewSession } from "../store.ts";
import { useT } from "../use-language.ts";

/**
 * 「新会话」那颗胶囊 —— **同一个动作，两处落点，任一时刻只画一颗**：
 *
 *  - 平时 → 顶栏，紧跟品牌名后面（`variant="appbar"`，见 App.tsx）；
 *  - 顶栏被藏起来时（状态栏那颗 ▴/▾）→ 侧栏抬头「项目」那一行（`variant="sidebar"`，
 *    见 Sidebar.tsx 里的 `appbarHidden` 条件）。
 *
 * 位置换过好几次，理由记在这儿：
 *  1. 最早在顶栏最左边，占着黄金位置，却跟右边的模型/设置那排抢宽度；
 *  2. 后来挪到侧栏「项目」头上（跟项目/会话列表同一件事，头上一句话就能新建）；
 *  3. 再后来只留顶栏那一颗 —— 理由是侧栏一收起 / 抽屉一关它就够不着了；
 *  4. 曾经又改成「两处都有、按侧栏开合分工」，结果展开时在「项目」旁边、收起来就跑到顶上，
 *     用户报的就是这个「按钮自己跑了」；
 *  5. 现在是用户定的优先级：**先放顶部**（侧栏开着也一样，位置跟收起时那颗完全一致），
 *     只有顶部整条不显示时才回落到侧栏抬头那一行。
 *
 * 「临时会话」（在右侧另开一条、不落盘）**不在这颗里**：它是另一个动作
 * （不换主对话），所以在**顶栏**右边那排入口里单独一颗，钉在「技能」左边，见 `TempChatButton.tsx`。
 */
export function NewChatButton({ variant = "appbar" }: { variant?: "appbar" | "sidebar" }) {
	const t = useT();
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
