import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentMobileShell } from "../mobile-shell-dom.ts";
import { centeredPopoverAnchor } from "../popover-anchor.ts";
import { filterEnabledModels, groupModels } from "../model-groups.ts";
import type { ModelOption } from "../types.ts";
import { setModel } from "../ws.ts";
import { tNow, useT } from "../use-language.ts";

/**
 * 模型选择器（P6）：点开是「筛选框 + 按厂家分组」的列表，而不是原生 select。
 *
 * 为什么不用原生 select：24 个模型里有重名（不同厂家同标签），原生 select 没法分组显示厂家，
 * 也没法筛选；用原生 `<optgroup>` 也解决不了重名辨认问题（组内同名仍然分不清）。
 *
 * **只列出已启用的模型**：在「模型」面板里停用的（provider 整体停用 / 单个模型停用）不出现
 * 在这里。停用的东西还能选中、选完又用不了，等于把已经做过的决定重新摆回眼前。
 * 判定走 `model-enabled.ts`，与面板、与服务端同一套白名单语义。
 */
export function ModelPicker({
	models,
	enabledAllowlist = [],
	current,
	disabled,
	defaultModel,
	onSetDefault,
	onSwitch,
}: {
	models: ModelOption[];
	/** 启用白名单（快照的 `enabledModels`）：空白数组 = 全开 */
	enabledAllowlist?: string[];
	current: string | null;
	disabled?: boolean;
	/** 本项目当前设的默认模型（新会话按它起步）；null = 没设过 */
	defaultModel?: string | null;
	/** 点行尾的图钉：设成默认；再点一次取消（null） */
	onSetDefault?: (modelId: string | null) => void;
	/**
	 * 选一个模型怎么生效。不传 = 主对话（走全局通道 `set_model`）；
	 * 临时聊天传它自己那条通道的实现（同一份 UI，别把主对话的通道写坏）。
	 */
	onSwitch?: (modelId: string) => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const boxRef = useRef<HTMLDivElement>(null);
	/**
	 * 菜单的 fixed 坐标（贴触发按钮正上方）：状态栏是 overflow:hidden，绝对定位会被裁掉。
	 * `arrow` = 小箭头相对菜单左边缘的偏移（**箭头中心对齐触发胶囊中心**）——
	 * 菜单被夹到视口边缘时，箭头仍然指得准，不会跟着漂。
	 */
	const [anchor, setAnchor] = useState<{ left: number; bottom: number; arrow: number } | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const mobile = currentMobileShell();

	/**
	 * 打开后量一次坐标：**菜单水平中心对齐触发胶囊中心**，再夹进视口。
	 *
	 * 以前是「菜单右边缘对齐胶囊右边缘」：菜单有 300px 宽、胶囊才一百多，
	 * 于是点下去菜单从左边冒出一大截 —— 看着不像从「我点的那个东西」长出来的。
	 * 手机上是底部抽屉（CSS 里 position:fixed + inset），不需要坐标。
	 * `filter` 变了菜单宽高会变，得重算；窗口 resize 同理（否则菜单停在旧坐标上）。
	 */
	useLayoutEffect(() => {
		if (!open || mobile) {
			setAnchor(null);
			return;
		}
		const measure = () => {
			const trigger = triggerRef.current?.getBoundingClientRect();
			const menu = menuRef.current?.getBoundingClientRect();
			if (!trigger || !menu) return;
			// 居中 + 小尾巴指向胶囊中心（都在 centeredPopoverAnchor 里算，与状态栏那个浮层同一套）
			setAnchor(
				centeredPopoverAnchor({
					trigger: { left: trigger.left, top: trigger.top, width: trigger.width, height: trigger.height },
					popover: { width: menu.width },
					viewport: { width: window.innerWidth, height: window.innerHeight },
					gap: 8,
				}),
			);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [open, mobile, filter]);

	// 点外面 / 按 Esc 关掉
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent) => {
			if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	/** 只留已启用的（当前选中的那个可能是刚被停用的 —— 那也不列，只在下头给一句提示） */
	const selectable = filterEnabledModels(models, enabledAllowlist);
	const groups = groupModels(selectable, filter);
	/**
	 * 抬头仍然从**全量**里查标签：当前模型可能刚被停用，这时候也要显示得出来，
	 * 否则按钮上会退化成一串 `provider/model` id（看着像坏了）。
	 */
	const currentLabel =
		models.find((model) => model.id === current)?.label ?? current ?? tNow("模型未就绪", "model not ready");
	/** 「一个都没有」和「筛不到」要说清楚，不然用户以为是筛选框的问题 */
	const noneEnabled = selectable.length === 0;

	return (
		<div className="model-picker" ref={boxRef}>
			<button
				ref={triggerRef}
				type="button"
				className="tool-chip model-trigger"
				onClick={() => {
					if (disabled) return;
					setFilter("");
					setOpen((value) => !value);
				}}
				disabled={disabled}
				title={current ?? "选择模型"}
			>
				<span className="tool-icon" aria-hidden="true">
					🤖
				</span>
				<span className="model-trigger-label">{currentLabel}</span>
				<span className="model-caret" aria-hidden="true">
					▾
				</span>
			</button>

			{open ? <div className="model-sheet-backdrop" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
			{open ? (
				<div
					ref={menuRef}
					className="model-menu"
					role="listbox"
					aria-label={t("选择模型")}
					// 手机走 CSS 抽屉（这里不给坐标）；桌面用现算的 fixed 坐标，先藏一帧避免闪
					style={mobile ? undefined : anchor ? { left: anchor.left, bottom: anchor.bottom } : { visibility: "hidden" }}
				>
					{/* 指向下方胶囊的小尾巴：没有它时菜单像凭空浮在对话上，
					    看不出是「从哪个按钮长出来的」（手机上菜单是整宽抽屉，不需要） */}
					{!mobile && anchor ? (
						<span className="model-menu-arrow" style={{ left: anchor.arrow }} aria-hidden="true" />
					) : null}
					{/* 手机上菜单是整宽的底部抽屉，需要一个明确可见的关闭入口 */}
					<button type="button" className="model-sheet-close" onClick={() => setOpen(false)} title={t("关闭")}>
						✕ 关闭
					</button>
					<div className="model-list">
						{groups.length === 0 ? (
							<div className="model-empty">
								{noneEnabled
									? t("没有启用的模型：去「模型」面板里勾选要用的", "No enabled models — pick some in the Models panel")
									: t("没有匹配的模型")}
							</div>
						) : null}
						{groups.map((group) => (
							<div className="model-group" key={group.provider}>
								<div className="model-group-title">{group.provider.toUpperCase()}</div>
								{group.models.map((model) => {
									const isDefault = model.id === defaultModel;
									return (
										<div className="model-row" key={model.id}>
											<button
												type="button"
												className={`model-item${model.id === current ? " model-item-on" : ""}`}
												onClick={() => {
													(onSwitch ?? setModel)(model.id);
													setOpen(false);
												}}
												title={model.id}
											>
												<span className="model-check" aria-hidden="true">
													{model.id === current ? "✓" : ""}
												</span>
												<span className="model-label">{model.label}</span>
											</button>
											{onSetDefault ? (
												<button
													type="button"
													className={`model-pin${isDefault ? " model-pin-on" : ""}`}
													onClick={() => onSetDefault(isDefault ? null : model.id)}
													title={isDefault ? "取消本项目的默认模型" : "设为本项目的默认模型（新会话用它起步）"}
													aria-pressed={isDefault}
												>
													{isDefault ? "📌" : "📍"}
												</button>
											) : null}
										</div>
									);
								})}
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}
