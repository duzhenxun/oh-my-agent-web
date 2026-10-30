/**
 * 顶栏「智能体引擎」切换（ADR-0024）。
 *
 * 一个按钮 + 一个浮层：浮层里列出注册表里的全部引擎（名字、短标签、能力说明、版本），
 * 当前那个打勾。切换会发 `set_engine`，服务端零重启换引擎 —— 项目清单、模型列表、
 * 能力矩阵都跟着换，所以这里**不做任何本地乐观状态**：等快照回来即可，避免「界面说切了、
 * 数据还是旧的」。
 *
 * 列表来自快照（`snapshot.engines`），不是再来一条接口 —— 遵守「快照是唯一事实源」。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { belowPopoverAnchor, centeredPopoverAnchor } from "../popover-anchor.ts";
import { useAppSelector } from "../store.ts";
import { setEngine } from "../ws.ts";
import type { EngineOption } from "../types.ts";
import { useT } from "../use-language.ts";

/** 机器人头 + 天线：和面板图标同一套描边，设置里的「引擎切换」也用它（见 SettingsPanel） */
function EngineIcon() {
	return (
		<svg
			className="engine-picker-icon"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.3}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<rect x="2.6" y="5.2" width="10.8" height="7.6" rx="2.3" />
			<path d="M8 5.2V3.3" />
			<circle cx="8" cy="2.4" r="0.85" fill="currentColor" stroke="none" />
			<circle cx="6" cy="9" r="0.8" fill="currentColor" stroke="none" />
			<circle cx="10" cy="9" r="0.8" fill="currentColor" stroke="none" />
		</svg>
	);
}

function Chevron() {
	return (
		<svg
			className="engine-picker-chevron"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			aria-hidden="true"
		>
			<path d="M4.4 6.2 8 9.8l3.6-3.6" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function Check() {
	return (
		<svg
			className="engine-picker-check"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.8}
			aria-hidden="true"
		>
			<path d="M3.4 8.4 6.6 11.6 12.6 4.8" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

/**
 * 引擎版本显示：语义化版本加 v，别的前缀（如假引擎的 "fake"）原样给，不硬凑一个 "v"
 */
function engineVersionText(version: string | null | undefined): string {
	if (!version) return "";
	return /^\d/.test(version) ? `v${version}` : version;
}

/**
 * 列表每一项上的版本号：**每个引擎各显各的**。
 *
 * 当前引擎优先用快照里那份（`versions.engine` 来自引擎握手，最准：懒启动的引擎
 * 只在真连上之后才知道版本）；其余引擎用服务端探测好的 `engine.version`。
 * 都没有就什么都不写 —— 宁可少一行字，也不要编一个版本号出来。
 */
function versionLabelOf(engine: EngineOption, isActive: boolean, live: string | null | undefined): string {
	const raw = (isActive ? live : null) ?? engine.version ?? null;
	return engineVersionText(raw);
}

/**
 * 引擎切换胶囊。
 *
 * `placement`：
 *   - `appbar`（默认）：在顶栏里，浮层从顶栏下沿/竖栏内侧掉下来；
 *   - `statusbar`：顶栏改成竖栏时（设置 → 界面 → 顶栏），这颗胶囊搬到**底部状态栏**
 *     「放行」那颗（审批模式）后面 —— 竖栏只有一百多像素宽，塞不下「图标 + 短名 + 引擎名 + 箭头」。
 *     状态栏贴在窗口最底，所以浮层要**向上**弹，否则会掉到屏幕外面。
 */
export function EnginePicker({ placement = "appbar" }: { placement?: "appbar" | "statusbar" } = {}) {
	const t = useT();
	const snapshot = useAppSelector((state) => state.snapshot);
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const popRef = useRef<HTMLDivElement | null>(null);
	/**
	 * 浮层坐标：**水平中心对齐触发胶囊**，再夹进视口；`arrow` 是小尾巴相对浮层左边缘的偏移。
	 * 顶栏本身不裁剪，但浮层比胶囊宽得多，靠 CSS 的 `right: 0` 对齐会整块往左偏 ——
	 * 点的是右边那颗胶囊，卡片却从左边冒出来，看不出是「从这里掉下来的」。
	 */
	const [anchor, setAnchor] = useState<{ left: number; top: number; arrow: number } | null>(null);

	const engines: EngineOption[] = snapshot?.engines ?? [];
	const activeName = snapshot?.engine ?? "";
	const active = engines.find((engine) => engine.name === activeName);
	const running = snapshot ? snapshot.running.status !== "idle" : false;

	// 打开后量一次坐标：居中 + 小尾巴指着胶囊中心（与状态栏模型菜单、子代理浮层同一套算法）
	useLayoutEffect(() => {
		if (!open) {
			setAnchor(null);
			return;
		}
		const measure = () => {
			const trigger = triggerRef.current?.getBoundingClientRect();
			const pop = popRef.current?.getBoundingClientRect();
			if (!trigger || !pop) return;
			/**
			 * 状态栏里的胶囊：状态栏贴着窗口最底，浮层只能**往上**长（往下就出屏了）。
			 * 和状态栏那颗上下文胶囊用**同一套算法**（`centeredPopoverAnchor`）：
			 * 水平居中于胶囊、夹进视口，小尾巴按「胶囊中心 − 浮层左边」现算 ——
			 * 以前这里是「左边缘对齐胶囊左边缘」+ `arrow: 0`，于是浮层从胶囊左外侧冒出来，
			 * 尾巴又贴在圆角上（看着像没有尾巴），根本看不出是从哪颗按钮长出来的。
			 */
			if (placement === "statusbar") {
				const { left, bottom, arrow } = centeredPopoverAnchor({
					trigger: { left: trigger.left, top: trigger.top, width: trigger.width, height: trigger.height },
					popover: { width: pop.width },
					viewport: { width: window.innerWidth, height: window.innerHeight },
					gap: 8,
				});
				// 浮层高度可能比一屏还高：夹一下，别让标题那一行跑到屏幕外
				setAnchor({ left, top: Math.max(8, window.innerHeight - bottom - pop.height), arrow });
				return;
			}
			// 从**顶栏下沿**掉下来，而不是从胶囊下沿：窄屏胶囊比顶栏矮，按胶囊算会把浮层压进顶栏一线
			const barBottom = triggerRef.current?.closest(".appbar")?.getBoundingClientRect().bottom ?? 0;
			const bottom = Math.max(trigger.top + trigger.height, barBottom);
			setAnchor(
				belowPopoverAnchor({
					// 只借它的水平中心与「底边」：高度不变，top 往上推到那条底边
					trigger: { left: trigger.left, top: bottom - trigger.height, width: trigger.width, height: trigger.height },
					popover: { width: pop.width },
					viewport: { width: window.innerWidth, height: window.innerHeight },
				}),
			);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [open, placement]);

	// 点外面 / Esc 关掉：浮层不是模态，不该拦住任何操作
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	// 快照里没有引擎清单（老服务端 / 还没连上）：不占位置，也不要一个点不动的按钮
	if (engines.length === 0) return null;

	const label = t(active?.label ?? activeName);
	const badge = active?.badge ?? activeName.toUpperCase();

	return (
		<div className={`engine-picker${placement === "statusbar" ? " engine-picker-in-statusbar" : ""}`} ref={box}>
			<button
				ref={triggerRef}
				type="button"
				className={`side-foot-btn engine-picker-btn${open ? " side-foot-btn-on" : ""}`}
				onClick={() => setOpen((value) => !value)}
				title={running ? "切换智能体引擎（回合进行中，先等它结束）" : "切换智能体引擎"}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`智能体引擎：${label}`}
			>
				<span className="side-foot-icon" aria-hidden="true">
					<EngineIcon />
				</span>
				<span className="engine-picker-badge">{badge}</span>
				<Chevron />
			</button>

			{open ? (
				<div
					ref={popRef}
					className="engine-pop"
					role="listbox"
					aria-label={t("智能体引擎")}
					// 先按不可见渲染一帧量宽度，再落到最终坐标（避免从静态位置闪一下）
					style={anchor ? { left: anchor.left, top: anchor.top } : { visibility: "hidden" }}
				>
					{/* 小尾巴：指着胶囊中心（顶栏那份朝上、状态栏那份朝下，见 CSS）。
					    它必须留在**滚动层外面** —— 浮层自己是 overflow: visible，一裁尾巴就没了。 */}
					{anchor ? <span className="engine-pop-arrow" style={{ left: anchor.arrow }} aria-hidden="true" /> : null}
					{/* 滚动只在这一层：浮层本身不能 overflow: hidden / auto，否则朝下的小尾巴会被裁掉
					    （和子代理浮层同一套做法） */}
					<div className="engine-pop-scroll">
						<div className="engine-pop-head">
							<span className="engine-pop-title">{t("智能体引擎")}</span>
							<span className="engine-pop-note">{t("切换后项目与会话跟着新引擎")}</span>
						</div>
						{engines.map((engine) => {
							const isActive = engine.name === activeName;
							const versionText = versionLabelOf(engine, isActive, snapshot?.versions.engine);
							return (
								<button
									type="button"
									key={engine.name}
									role="option"
									aria-selected={isActive}
									disabled={running && !isActive}
									className={`engine-option${isActive ? " engine-option-on" : ""}`}
									onClick={() => {
										setOpen(false);
										if (!isActive) setEngine(engine.name);
									}}
									title={
										running && !isActive
											? t("回合进行中，先中断或等它结束", "A turn is running — interrupt it or wait for it to end")
											: undefined
									}
								>
									<span className="engine-option-top">
										<span className="engine-option-icon" aria-hidden="true">
											<EngineIcon />
										</span>
										<span className="engine-option-badge">{engine.badge}</span>
										<span className="engine-option-label">{t(engine.label)}</span>
										{versionText ? <span className="engine-option-version">{versionText}</span> : null}
										<span className="engine-option-tail">{isActive ? <Check /> : null}</span>
									</span>
									{engine.description ? <span className="engine-option-desc">{t(engine.description)}</span> : null}
									<span className="engine-option-caps">
										{engine.capabilities.approvals ? t("审批拦截", "Approval gate") : t("自行授权", "Self-approved")}
										{engine.capabilities.modelSwitch ? ` · ${t("模型可切", "switchable models")}` : ""}
										{engine.capabilities.thinkingLevel ? ` · ${t("思考强度", "thinking level")}` : ""}
										{engine.capabilities.resume ? ` · ${t("可续历史", "resumable history")}` : ""}
									</span>
								</button>
							);
						})}
						{running ? <div className="engine-pop-hint">{t("有回合在跑：先中断或等结束再切")}</div> : null}
					</div>
				</div>
			) : null}
		</div>
	);
}
