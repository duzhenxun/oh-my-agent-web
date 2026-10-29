/**
 * 快捷键速查表浮层（App 里挂一次；开它走 `shortcut-sheet.ts` 的模块状态）。
 *
 * 三件事刻意这么定：
 *  1. **未绑定的动作也列出来**（灰字「未设置」）：速查表要回答的是「我现在有哪些动作」，
 *     不只是「哪些键能按」—— 用户记得有个动作、按不出来时，先看到「它压根没绑」才不冤。
 *  2. **顺序跟设置面板完全一致**（都读 `SHORTCUT_DEFS`）：两边找同一个动作不该换位置。
 *  3. **组合键用 `<kbd>` 画成胶囊**，等宽字体 + 浅底，跟全文搜索浮层里那套一致。
 */
import { useEffect } from "react";
import { sheetRows, useShortcutSheetOpen, closeShortcutSheet } from "../shortcut-sheet.ts";
import { formatCombo, isMacPlatform } from "../shortcuts.ts";
import { useShortcuts } from "../use-shortcuts.ts";
import { useT } from "../use-language.ts";

export function ShortcutSheet() {
	const t = useT();
	const open = useShortcutSheetOpen();
	const [map] = useShortcuts();
	const mac = isMacPlatform();

	// Esc 关掉：用捕获阶段，免得被下层（比如设置面板）先吃掉
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			closeShortcutSheet();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open]);

	if (!open) return null;
	const rows = sheetRows(map, mac);
	const hint = formatCombo(map.cheatSheet, mac);

	return (
		<div
			className="shortcut-sheet-backdrop"
			onClick={(event) => {
				// 只在点灰底时关：点表格里拖选文字、点空白行都不该把它关掉
				if (event.target === event.currentTarget) closeShortcutSheet();
			}}
		>
			<div className="shortcut-sheet" role="dialog" aria-modal="true" aria-label={t("快捷键速查表", "Shortcuts")}>
				<div className="shortcut-sheet-head">
					<span className="shortcut-sheet-title">{t("快捷键", "Shortcuts")}</span>
					<span className="shortcut-sheet-sub">
						{t(
							"设置 → 快捷键 里可以改；留空就是不用",
							"Change them in Settings → Shortcuts; leave one empty to disable it",
						)}
					</span>
					<button
						type="button"
						className="shortcut-sheet-close"
						onClick={closeShortcutSheet}
						aria-label={t("关闭速查表", "Close the cheat sheet")}
						title={t("关闭（Esc）", "Close (Esc)")}
					>
						✕
					</button>
				</div>

				<div className="shortcut-sheet-grid">
					{rows.map((row) => (
						<div className={`sheet-row${row.combo ? "" : " sheet-row-off"}`} key={row.id}>
							<span className="sheet-label">{t(row.label, row.labelEn)}</span>
							{row.combo ? (
								<kbd className="sheet-kbd">{row.combo}</kbd>
							) : (
								<span className="sheet-unbound">{t("未设置", "Unbound")}</span>
							)}
						</div>
					))}
				</div>

				<div className="shortcut-sheet-foot">
					{t("Esc 关闭", "Esc to close")}
					{hint ? t(`；再按一次 ${hint} 也可以关`, `; press ${hint} again to close`) : ""}
				</div>
			</div>
		</div>
	);
}
