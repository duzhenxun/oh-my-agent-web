import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProvidersPanel } from "./ProvidersPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { SkillsPanel } from "./SkillsPanel.tsx";
import { EngineMcpView } from "./EngineMcpView.tsx";
import { EnginePluginsView } from "./EnginePluginsView.tsx";
import { PluginsPanel } from "./PluginsPanel.tsx";
import { McpPanel } from "./McpPanel.tsx";
import { PushPanel } from "./PushPanel.tsx";
import { VoicePanel } from "./VoicePanel.tsx";
import { AgentsPanel } from "./AgentsPanel.tsx";
import { PanelIcon, type PanelIconName } from "./PanelIcon.tsx";
import { SortablePanelTabs } from "./SortablePanelTabs.tsx";
import { PanelOrderRow } from "./PanelOrderRow.tsx";
import { usePanelOrder } from "../panel-order.ts";
import { useModalSize, type ResizeAnchor } from "../use-modal-size.ts";
import { useModalMove } from "../use-modal-move.ts";
import { useAppState } from "../store.ts";
import { useT } from "../use-language.ts";
import { usePrefFlags } from "../use-pref-flags.ts";
import { APPBAR_PARTS, APPBAR_PART_KEY } from "../ui-prefs.ts";

export type Panel = PanelIconName | null;

/** 顶栏与弹窗里的标签文案；排列顺序统一由 usePanelOrder 提供。 */
const PANEL_LABEL: Record<Exclude<Panel, null>, string> = {
	models: "模型",
	skills: "技能",
	push: "推送",
	plugins: "插件",
	mcp: "MCP",
	voice: "语音",
	agents: "子代理",
	settings: "设置",
};
/** 顶栏 / 弹窗 tab 的英文名（设置面板里那几组勾选框用的是另一张，见 SettingsPanel） */
const PANEL_LABEL_EN: Record<Exclude<Panel, null>, string> = {
	models: "Models",
	skills: "Skills",
	push: "Push",
	plugins: "Plugins",
	mcp: "MCP",
	voice: "Voice",
	agents: "Subagents",
	settings: "Settings",
};

/** 弹窗顶部那一条反馈（只留一条，到点自己消失） */
/** 四只手柄的渲染顺序：先四角（nw / ne / sw / se），CSS 按类名摆位置 */
const RESIZE_CORNERS = ["nw", "ne", "sw", "se"] as const;

type ModalTip = { key: string; text: string; level: "info" | "warn" | "error"; at: number };

/** 显示多久：错误留久一点（否则用户还没看清就没了） */
const TIP_TTL_MS = (level: ModalTip["level"]): number =>
	level === "error" ? 12_000 : level === "warn" ? 8_000 : 5_000;

/**
 * 侧栏 / 顶栏入口（P7）：模型 / 技能 / 推送 / 插件 / 设置。
 *
 * 分期落地（用户明确："设置先放上，后面一步步开发"）：
 *   - 模型：现在就能看到「按厂家分组的可用模型 + 当前模型」；
 *     「添加模型」已可用：配 provider（base url / api key）+ 模型 id（ADR-0025 A 期）；
 *   - 技能：管理技能的入口先放上，能力待做（读 ~/.pi 下的技能目录 + 启停）；
 *   - 插件：pi 的插件包 + 本机扩展，可启停（改 pi 自己的 settings.json，对新会话生效）；
 *   - 设置：直接复用已有的设置面板（快捷短语）。
 */
export function SidebarMenu({
	initialPanel = null,
	variant = "full",
	placement = "footer",
	items,
	panel: controlledPanel,
	onPanelChange,
	leadingAction,
}: {
	/** 收起态由活动栏按钮指定打开哪个面板 */
	initialPanel?: Panel;
	/** full = 三个入口 + 弹窗；modal = 只渲染弹窗（收起态用） */
	variant?: "full" | "modal";
	/** footer = 侧栏底部；appbar = 顶部那一排 */
	placement?: "footer" | "appbar";
	/** 只渲染这几项（默认全要）；实际传什么由设置 → 顶栏的勾选决定（见 App.tsx 的 menuItems） */
	items?: Panel[];
	/**
	 * 受控的「当前打开哪个面板」：顶栏的子代理徽标要能被别处点开
	 * （跑着的子代理挂在徽标上，点它直接进面板），所以把这一格提到 App 里。
	 */
	panel?: Panel;
	onPanelChange?: (panel: Panel) => void;
	/**
	 * 插在「技能」那颗**左边**的一颗入口（顶栏用它放「临时会话」，见 TempChatButton）。
	 *
	 * 为什么做成「插在技能左边」而不是「排在这一排最前面」：它在语义上属于「再开一条会话」，
	 * 但位置上用户要求贴着技能（离「模型 / 技能」这组面板入口近，一眼就能看到）；
	 * 而这一排的顺序本身是**可拖**的（`panelOrder`），所以不能写成「第一颗 / 最后一颗」，
	 * 只能钉在某个面板前面 —— 那个面板就是技能。技能被设置里的勾选框关掉时，它退回排头
	 * （总比跟着一起消失强：这颗是动作，不是面板）。
	 *
	 * 传函数而不是节点：图标 / 文案这两个开关（设置 → 界面 → 顶栏文字与图标）的算法在下面，
	 * 外面拿不到，没必要复制一份。
	 */
	/** 排在所有面板入口**之前**的动作入口（目前是「临时会话」）：不跟面板顺序走 */
	leadingAction?: (parts: { showIcon: boolean; showLabel: boolean }) => ReactNode;
} = {}) {
	const t = useT();
	const [panelOrder, setPanelOrder] = usePanelOrder();
	const [uncontrolledPanel, setUncontrolledPanel] = useState<Panel>(initialPanel);
	const panel = controlledPanel !== undefined ? controlledPanel : uncontrolledPanel;
	const setPanel = (next: Panel) => {
		if (onPanelChange) onPanelChange(next);
		if (controlledPanel === undefined) setUncontrolledPanel(next);
	};
	// 弹窗尺寸可拖（模型面板里价格 / 分时价格一多，默认的 760 高就不够用了）
	//
	// 尺寸与位置互相依赖：调四个角时要推动位置（锢住对面的角），而位置钩子又要知道尺寸。
	// 用一个 ref 打通，不把两个钩子合并 —— 它们各自有独立的持久化 / 夹取逻辑。
	const anchorRef = useRef<ResizeAnchor | null>(null);
	const modalSize = useModalSize({ anchor: anchorRef });
	/** 面板可以拖动位置（推开来对照着看被挡住的对话；双击头部复位） */
	const modalMove = useModalMove({ size: modalSize.size });
	anchorRef.current = {
		begin: modalMove.beginResize,
		shift: modalMove.shiftBy,
		commit: modalMove.commitResize,
	};
	/**
	 * 弹窗里的反馈：服务端的提示条（`.error-bar` / `NoticeBar`）都在工作区顶上，
	 * 而弹窗是全屏遮罩 —— 用户在弹窗里操作时**什么都看不到**（保存成功/失败郿如此）。
	 * 这里把「打开弹窗之后新出现的提示 + 请求错误」镜像到弹窗顶部。
	 *
	 * 三条纪律（都是被「顶部堆了一堆提示」撞出来的）：
	 *   - 只留**最新一条**：旧消息叠成三行只会挡内容；
	 *   - 到点**自己消失**（提示 / 警告 5s、错误 12s）：服务端的 notices 会挂很久，不能跟着它；
	 *   - 打开 / 切面板时把当时的提示全吸收掉，不把旧消息当成这次操作的结果。
	 */
	const { snapshot, lastError } = useAppState();
	const seenNotices = useRef<Set<string>>(new Set());
	/** 基线记「文本」：lastError 现在是 `{ text, conversationId }`，比对文本就够了 */
	const errorBaseline = useRef<string | null>(lastError?.text ?? null);
	const [tip, setTip] = useState<ModalTip | null>(null);

	useEffect(() => {
		seenNotices.current = new Set((snapshot?.notices ?? []).map((notice) => notice.id));
		errorBaseline.current = lastError?.text ?? null;
		setTip(null);
		// 只看「本次打开面板之后」出现的提示；snapshot / lastError 故意不进依赖（否则自己就被吸收掉了）
	}, [panel]);

	// 新提示：只收最新一条（一次操作可能连推好几条）
	useEffect(() => {
		const fresh = (snapshot?.notices ?? []).filter((notice) => !seenNotices.current.has(notice.id));
		if (fresh.length === 0) return;
		for (const notice of fresh) seenNotices.current.add(notice.id);
		const latest = fresh[fresh.length - 1];
		if (latest) setTip({ key: `notice-${latest.id}`, text: latest.text, level: latest.level, at: Date.now() });
	}, [snapshot?.notices]);

	// 请求错误（例如「保存失败」）也走同一张条
	useEffect(() => {
		const text = lastError?.text ?? null;
		if (!text || text === errorBaseline.current) return;
		errorBaseline.current = text;
		setTip({ key: `error-${Date.now()}`, text, level: "error", at: Date.now() });
	}, [lastError]);

	// 到点自己消失（服务端的 notices 会挂很久，不能跟着它留在弹窗里）
	useEffect(() => {
		if (!tip) return;
		const timer = setTimeout(() => {
			setTip((current) => (current && Date.now() - current.at >= TIP_TTL_MS(current.level) ? null : current));
		}, TIP_TTL_MS(tip.level));
		return () => clearTimeout(timer);
	}, [tip]);
	const wanted = (key: Exclude<Panel, null>) => !items || items.includes(key);
	const visiblePanelOrder = panelOrder.filter(wanted);
	/**
	 * 顶栏那一排要不要画图标 / 文案（设置 → 界面 → 「顶栏文字与图标」）。
	 * 只对 `placement="appbar"` 生效；侧栏底部那排与弹窗 tab 保持原样（那是收起态 / 窄屏的兜底，越能认越好）。
	 * 两个都不勾时图标兜底：一排「点得到但看不见」的按钮等于把入口弄丢了。
	 */
	const [appbarParts] = usePrefFlags(APPBAR_PARTS, APPBAR_PART_KEY);
	const onAppbar = placement === "appbar";
	const showLabel = !onAppbar || appbarParts.label;
	const showIcon = !onAppbar || appbarParts.icon || !appbarParts.label;
	const item = (key: Exclude<Panel, null>, label: string) => (
		<button
			type="button"
			key={key}
			data-panel-key={key}
			title={label}
			className={`side-foot-btn side-foot-btn-${key}${panel === key ? " side-foot-btn-on" : ""}`}
			onClick={() => setPanel(panel === key ? null : key)}
		>
			{showIcon ? (
				<span className="side-foot-icon" aria-hidden="true">
					<PanelIcon name={key} />
				</span>
			) : null}
			{showLabel ? <span className="side-foot-label">{label}</span> : null}
		</button>
	);

	/**
	 * 点弹窗外那圈灰底 = 关掉。
	 *
	 * 光判断 `click` 的 target 不够：在弹窗里拖选文字、或者拖右下角那把手一直拖到外面再松手，
	 * click 的 target 都会落到灰底上（浏览器把「按下」与「松开」的最近公共祖先当 target），
	 * 于是「选了一段字」和「刚调完大小」都会顺手把弹窗关掉。所以**按下和松开都得在灰底上**。
	 * 审批弹窗（ApprovalDialog）不这么做 —— 那个必须表态，不能被一次误点吞掉（ADR-0013）。
	 */
	const backdropPressed = useRef(false);
	const closeOnBackdrop = {
		onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => {
			backdropPressed.current = event.target === event.currentTarget;
		},
		onClick: (event: React.MouseEvent<HTMLDivElement>) => {
			const pressedHere = backdropPressed.current;
			backdropPressed.current = false;
			if (pressedHere && event.target === event.currentTarget) setPanel(null);
		},
	};

	return (
		<div className={placement === "appbar" ? "appbar-menu" : "side-foot"}>
			{variant === "full" ? (
				<PanelOrderRow className="side-foot-row" order={visiblePanelOrder}>
					{/**
					 * 动作入口（临时会话）**永远是第一个**，不参与面板排序。
					 *
					 * 以前它挂在「技能」左边：技能被拖到哪儿，它就跟到哪儿（甚至跑到最右边），
					 * 用户的原话是「无论别的图标位置怎么换，它都在最左边第一个」。
					 * 这里也不带 `data-panel-key`，所以 `PanelOrderRow` 的 FLIP 动画不会把它算进去 ——
					 * 它本来就不动，跟着滑反而像丢了位置。
					 */}
					{leadingAction?.({ showIcon, showLabel })}
					{/* 与弹窗 Tab 共用顺序；设置里的显隐开关只过滤，不另排一份。 */}
					{visiblePanelOrder.map((key) => item(key, t(PANEL_LABEL[key], PANEL_LABEL_EN[key])))}
				</PanelOrderRow>
			) : null}

			{panel
				? createPortal(
						<div
							className="modal-backdrop"
							role="dialog"
							aria-modal="true"
							aria-label={t("工作台面板")}
							{...closeOnBackdrop}
						>
							<div className="modal big-modal" style={{ ...modalSize.style, ...modalMove.style }}>
								{/* 关闭按钮固定在弹窗右上角，不跟 tab 同一行：
								    那一行会横向滚动（手机上尤其），✕ 跟着滚就找不到了 */}
								<button
									type="button"
									className="btn btn-tiny big-modal-close"
									onClick={() => setPanel(null)}
									title={t("关闭", "Close")}
								>
									✕
								</button>
								{/* 拖头部空白处移动弹窗；拖 Tab 本身则排序并实时同步顶栏。 */}
								<SortablePanelTabs
									order={panelOrder}
									active={panel}
									label={(key) => t(PANEL_LABEL[key], PANEL_LABEL_EN[key])}
									onSelect={setPanel}
									onOrderChange={setPanelOrder}
									onHeadPointerDown={modalMove.start}
									onHeadDoubleClick={modalMove.reset}
									headTitle={t(
										"拖动 Tab 排序；拖动空白处移动面板（双击复位）",
										"Drag tabs to reorder; drag empty space to move the panel (double-click to reset)",
									)}
								/>

								{tip ? (
									<div className="modal-notices">
										<div
											className={`notice${tip.level === "error" ? " notice-error" : tip.level === "warn" ? " notice-warn" : ""}`}
											key={tip.key}
										>
											{tip.text}
										</div>
									</div>
								) : null}

								<div className="big-modal-body">
									{panel === "models" ? <ProvidersPanel /> : null}

									{panel === "skills" ? <SkillsPanel /> : null}
									{panel === "push" ? <PushPanel /> : null}
									{/* 插件 / MCP 是**按引擎**的：pi 用它自己的面板（package / 暴露方式那一套），
									    其它引擎各用一份「引擎给什么就画什么」的视图（见 EnginePluginsView / EngineMcpView） */}
									{panel === "plugins" ? (
										(snapshot?.engine ?? "pi") === "pi" ? (
											<PluginsPanel />
										) : (
											<EnginePluginsView engine={snapshot?.engine ?? ""} />
										)
									) : null}
									{panel === "mcp" ? (
										(snapshot?.engine ?? "pi") === "pi" ? (
											<McpPanel />
										) : (
											<EngineMcpView engine={snapshot?.engine ?? ""} />
										)
									) : null}
									{panel === "voice" ? <VoicePanel /> : null}
									{panel === "agents" ? <AgentsPanel /> : null}
									{panel === "settings" ? <SettingsPanel /> : null}
								</div>

								{/* 四个角都能拖：拖哪个角，对面的角就不动。双击任意手柄回到默认尺寸（位置也复位） */}
								{RESIZE_CORNERS.map((corner) => (
									<div
										key={corner}
										className={`modal-resize modal-resize-${corner}`}
										role="separator"
										aria-label={t("调整面板大小")}
										title={t("拖动调整窗口大小（双击复位）")}
										onPointerDown={(event) => modalSize.start(event, corner)}
										onDoubleClick={() => {
											modalSize.reset();
											modalMove.reset();
										}}
									/>
								))}
							</div>
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}
