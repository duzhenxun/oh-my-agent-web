import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ProvidersPanel } from "./ProvidersPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { SkillsPanel } from "./SkillsPanel.tsx";
import { PushPanel } from "./PushPanel.tsx";
import { useModalSize } from "../use-modal-size.ts";
import { useAppState } from "../store.ts";

type Panel = "models" | "skills" | "push" | "settings" | null;

/** 弹窗顶部那一条反馈（只留一条，到点自己消失） */
type ModalTip = { key: string; text: string; level: "info" | "warn" | "error"; at: number };

/** 显示多久：错误留久一点（否则用户还没看清就没了） */
const TIP_TTL_MS = (level: ModalTip["level"]): number =>
	level === "error" ? 12_000 : level === "warn" ? 8_000 : 5_000;

/**
 * 一套线性小图标（16 格），替掉原来的大彩 emoji：
 * emoji 在不同系统上大小/风格都不一样（有的还特别大），一排放在顶栏很难看。
 */
function PanelIcon({ name }: { name: Exclude<Panel, null> }) {
	const common = {
		viewBox: "0 0 16 16",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.3,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
		"aria-hidden": true,
	};
	if (name === "models")
		return (
			<svg {...common}>
				<rect x="2.8" y="5.4" width="10.4" height="7.6" rx="2.2" />
				<path d="M8 5.4V3.4" />
				<circle cx="8" cy="2.6" r="0.85" fill="currentColor" stroke="none" />
				<circle cx="6" cy="9.2" r="0.8" fill="currentColor" stroke="none" />
				<circle cx="10" cy="9.2" r="0.8" fill="currentColor" stroke="none" />
			</svg>
		);
	if (name === "skills")
		return (
			<svg {...common}>
				<rect x="2.2" y="5.9" width="11.6" height="7.4" rx="1.7" />
				<path d="M6.1 5.9V4.3c0-.6.5-1.1 1.1-1.1h1.6c.6 0 1.1.5 1.1 1.1v1.6" />
				<path d="M2.2 9.3h11.6" />
			</svg>
		);
	if (name === "push")
		return (
			<svg {...common}>
				<path d="M4.3 11.1V7.7a3.7 3.7 0 1 1 7.4 0v3.4l1.1 1.5H3.2l1.1-1.5Z" />
				<path d="M6.5 14.1a1.6 1.6 0 0 0 3 0" />
			</svg>
		);
	return (
		<svg {...common}>
			<path d="M2.6 5.4h10.8M2.6 10.6h10.8" />
			<circle cx="6" cy="5.4" r="1.7" fill="var(--bg-elev)" />
			<circle cx="10.2" cy="10.6" r="1.7" fill="var(--bg-elev)" />
		</svg>
	);
}

/**
 * 侧栏底部入口（P7）：模型 / 技能 / 设置。
 *
 * 分期落地（用户明确："设置先放上，后面一步步开发"）：
 *   - 模型：现在就能看到「按厂家分组的可用模型 + 当前模型」；
 *     「添加模型」已可用：配 provider（base url / api key）+ 模型 id（ADR-0025 A 期）；
 *   - 技能：管理技能的入口先放上，能力待做（读 ~/.pi 下的技能目录 + 启停）；
 *   - 设置：直接复用已有的设置面板（快捷短语）。
 */
export function SidebarMenu({
	initialPanel = null,
	variant = "full",
	placement = "footer",
	items,
}: {
	/** 收起态由活动栏按钮指定打开哪个面板 */
	initialPanel?: Panel;
	/** full = 三个入口 + 弹窗；modal = 只渲染弹窗（收起态用） */
	variant?: "full" | "modal";
	/** footer = 侧栏底部；appbar = 顶部那一排 */
	placement?: "footer" | "appbar";
	/** 只渲染这几项（默认四项全要）；模型 / 技能 / 推送 现在在顶栏，设置留在状态栏 */
	items?: Panel[];
} = {}) {
	const [panel, setPanel] = useState<Panel>(initialPanel);
	// 弹窗尺寸可拖（模型面板里价格 / 分时价格一多，默认的 760 高就不够用了）
	const modalSize = useModalSize();
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
	const errorBaseline = useRef<string | null>(lastError);
	const [tip, setTip] = useState<ModalTip | null>(null);

	useEffect(() => {
		seenNotices.current = new Set((snapshot?.notices ?? []).map((notice) => notice.id));
		errorBaseline.current = lastError;
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
		if (!lastError || lastError === errorBaseline.current) return;
		errorBaseline.current = lastError;
		setTip({ key: `error-${Date.now()}`, text: lastError, level: "error", at: Date.now() });
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
	const item = (key: Exclude<Panel, null>, label: string) => (
		<button
			type="button"
			title={label}
			className={`side-foot-btn side-foot-btn-${key}${panel === key ? " side-foot-btn-on" : ""}`}
			onClick={() => setPanel(panel === key ? null : key)}
		>
			<span className="side-foot-icon" aria-hidden="true">
				<PanelIcon name={key} />
			</span>
			<span className="side-foot-label">{label}</span>
		</button>
	);

	return (
		<div className={placement === "appbar" ? "appbar-menu" : "side-foot"}>
			{variant === "full" ? (
				<div className="side-foot-row">
					{wanted("models") ? item("models", "模型") : null}
					{wanted("skills") ? item("skills", "技能") : null}
					{wanted("push") ? item("push", "推送") : null}
					{wanted("settings") ? item("settings", "设置") : null}
				</div>
			) : null}

			{panel
				? createPortal(
						<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="工作台面板">
							<div className="modal big-modal" style={modalSize.style}>
								<div className="big-modal-head">
									{(["models", "skills", "push", "settings"] as const).map((key) => (
										<button
											type="button"
											key={key}
											className={`big-tab${panel === key ? " big-tab-on" : ""}`}
											onClick={() => setPanel(key)}
										>
											<span className="big-tab-icon">
												<PanelIcon name={key} />
											</span>
											{key === "models" ? "模型" : key === "skills" ? "技能" : key === "push" ? "推送" : "设置"}
										</button>
									))}
									<span className="topbar-spacer" />
									<button type="button" className="btn btn-tiny" onClick={() => setPanel(null)} title="关闭">
										✕
									</button>
								</div>

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
									{panel === "settings" ? <SettingsPanel /> : null}
								</div>

								{/* 右下角拖拽手柄：拖改宽高，双击回默认（尺寸存 localStorage） */}
								<div
									className="modal-resize"
									role="separator"
									aria-label="调整面板大小"
									title="拖动调整窗口大小（双击复位）"
									onPointerDown={modalSize.start}
									onDoubleClick={modalSize.reset}
								/>
							</div>
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}
