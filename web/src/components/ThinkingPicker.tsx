import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { centeredPopoverAnchor } from "../popover-anchor.ts";
import { currentMobileShell } from "../mobile-shell-dom.ts";
import { setThinkingLevel } from "../ws.ts";
import { useT } from "../use-language.ts";
import { ThinkingIcon } from "./ThinkingIcon.tsx";

/** 档位的中文标签（pi 的档位是英文，界面按用户习惯显示中文） */
const LABELS: Record<string, string> = {
	off: "关",
	minimal: "最低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最高",
};

/**
 * 档位的英文标签**写在这里、不进 `i18n-en.ts` 的通用表**：
 * 「中 / 高 / 低」这些词在别处还有别的意思（字号「中」、音量「高」…），
 * 撞到同一张表里就成了「High」字号 —— 所以按档位 id 就地给英文。
 */
const LABELS_EN: Record<string, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Very high",
	max: "Max",
};

/**
 * 思考强度选择器（P4）：只有模型支持推理时才出现（档位列表为空就整个不渲染）。
 * ⚡ + 当前档位的短标签 + ▾，点开是完整列表。
 *
 * **2026-11-23 改成自绘浮层**（用户：「模型强度，下拉一样，也需要有个尾巴」）：
 * 原来它用一个透明的原生 `<select>` 盖住整颗胶囊 —— 好处是键盘/无障碍零成本，
 * 代价是**下拉菜单是系统的**，长得跟旁边「模型」那颗自绘菜单完全两样（没有小尾巴、
 * 没有勾选、字体也不一样）。现在照 `ModelPicker` 那套重写：
 *   - 触发按钮还是那颗 `.tool-chip`（⚡ + 档位 + ▾）；
 *   - 菜单复用 `.model-menu` + `.model-menu-arrow`（同一套样式、同一个居中小尾巴）；
 *   - 手机上 `.model-menu` 会变底部抽屉，尾巴自动不画（跟模型菜单一致）。
 * 键盘：按钮可 Tab 聚焦、Enter/Space 打开，Esc / 点外面关闭；列表项是真按钮。
 */
export function ThinkingPicker({ level, levels }: { level: string | null; levels: string[] }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [anchor, setAnchor] = useState<{ left: number; bottom: number; arrow: number } | null>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const mobile = currentMobileShell();

	const current = level ?? levels[0] ?? "";
	const label = (item: string) => t(LABELS[item] ?? item, LABELS_EN[item] ?? item);

	// 打开后量坐标：菜单水平中心对齐触发胶囊中心，尾巴指向它（与模型菜单同一套算法）
	useLayoutEffect(() => {
		if (!open || mobile) {
			setAnchor(null);
			return;
		}
		const measure = () => {
			const trigger = triggerRef.current?.getBoundingClientRect();
			const menu = menuRef.current?.getBoundingClientRect();
			if (!trigger || !menu) return;
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
	}, [open, mobile]);

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

	if (levels.length === 0) return null;

	return (
		<div className="thinking-picker-box" ref={boxRef}>
			<button
				ref={triggerRef}
				type="button"
				className="tool-chip thinking-picker"
				title={t("思考强度（越高的档位越慢，推理也更细）", "Thinking level (higher is slower but reasons more finely)")}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="tool-icon" aria-hidden="true">
					<ThinkingIcon />
				</span>
				<span className="thinking-value">{label(current)}</span>
				<span className="thinking-caret" aria-hidden="true">
					▾
				</span>
			</button>

			{open ? <div className="model-sheet-backdrop" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
			{open ? (
				<div
					ref={menuRef}
					className="model-menu thinking-menu"
					role="listbox"
					aria-label={t("思考强度", "Thinking level")}
					style={mobile ? undefined : anchor ? { left: anchor.left, bottom: anchor.bottom } : { visibility: "hidden" }}
				>
					{!mobile && anchor ? (
						<span className="model-menu-arrow" style={{ left: anchor.arrow }} aria-hidden="true" />
					) : null}
					<button type="button" className="model-sheet-close" onClick={() => setOpen(false)} title={t("关闭")}>
						✕ {t("关闭", "Close")}
					</button>
					<div className="model-list">
						{levels.map((item) => (
							<button
								key={item}
								type="button"
								className={`model-item${item === current ? " model-item-on" : ""}`}
								onClick={() => {
									setThinkingLevel(item);
									setOpen(false);
								}}
							>
								<span className="model-check" aria-hidden="true">
									{item === current ? "✓" : ""}
								</span>
								<span className="model-label">{label(item)}</span>
							</button>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}
