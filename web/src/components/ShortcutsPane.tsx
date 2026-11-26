/**
 * 设置 → 快捷键（`SettingsPanel` 的一个 Tab）。
 *
 * 一行一个动作：左边名字 + 一句说明，右边是**组合键胶囊**（点一下进入录制）+ 一颗 ✕（= 不设置）。
 * 底部一颗「恢复默认设置」。
 *
 * 三个刻意的选择：
 *  1. **录制用「按一下」而不是下拉选键**：下拉要选修饰键 × 主键两轮，还得自己防重复；
 *     直接按键既快又不会造出不合法的组合。录制期间 `Escape` 取消、点别处取消。
 *  2. **非法组合当场拒绝、并说清为什么**：被浏览器占用（⌘T/⌘W…）和跟别的动作撞车都不静默吞。
 *     两者都是「绑上了但不生效 / 一按开两个面板」，比没绑更糟。
 *  3. **「不设置」是一等公民**：`null` 存在表里（不是删键），所以刷新后它仍然是空的，
 *     不会被默认值悄悄填回来 —— 用户说的是「可以不设置」。
 */
import { useEffect, useState } from "react";
import {
	SHORTCUT_DEFS,
	SHORTCUT_GROUPS,
	comboFromEvent,
	defaultShortcuts,
	findConflict,
	formatCombo,
	isLoneModifierEvent,
	isMacPlatform,
	isReservedCombo,
	loneModifierCombo,
	shortcutLabel,
	noteModifierKeys,
	type ShortcutId,
} from "../shortcuts.ts";
import { openShortcutSheet } from "../shortcut-sheet.ts";
import { useShortcuts } from "../use-shortcuts.ts";
import { useT } from "../use-language.ts";

export function ShortcutsPane() {
	const t = useT();
	const [map, save] = useShortcuts();
	const mac = isMacPlatform();
	/** 正在录制的动作（同一时刻只录一个） */
	const [recording, setRecording] = useState<ShortcutId | null>(null);
	/** 录制时遇到的问题（浏览器占用 / 撞车）——只说一句，不弹窗 */
	const [notice, setNotice] = useState<string | null>(null);

	/**
	 * 录制：等下一个「带修饰键的键」。
	 *
	 * 用**捕获阶段** + `stopPropagation`：否则 App 里那个全局派发器会先拿到这一下，
	 * 录 ⌘K 就等于当场执行了一遍「新会话」。捕获先于冒泡，正好用来截胡。
	 */
	useEffect(() => {
		if (!recording) return;
		/**
		 * 刚按下、还没松开的那颗修饰键（`event.code`）。松手时若没按过别的键，那一下就是
		 * 「单键」绑定（右 ⌘ / 右 ⌥ / ⌃ / Alt）。
		 */
		let loneCode: string | null = null;
		/** 验收一条组合键：被浏览器占用 / 跟别的动作撞车都不静默吞 */
		const apply = (combo: string): void => {
			if (isReservedCombo(combo)) {
				setNotice(
					t(
						`「${formatCombo(combo, mac)}」会被浏览器先吃掉（比如开关标签页/窗口），换个组合`,
						`${formatCombo(combo, mac)} is reserved by the browser — pick another combo`,
					),
				);
				return;
			}
			const conflict = findConflict(map, combo, recording);
			if (conflict) {
				const label = shortcutLabel(conflict);
				setNotice(
					t(
						`「${formatCombo(combo, mac)}」已经给「${label.zh}」了，先把它清掉或换一个`,
						`${formatCombo(combo, mac)} is already used by “${label.en}” — clear it or pick another`,
					),
				);
				return;
			}
			save({ ...map, [recording]: combo });
			setRecording(null);
			setNotice(null);
		};
		const onKey = (event: KeyboardEvent) => {
			// 先记左右修饰键（右 ⌘ / 右 ⌥）：主键事件本身看不出是哪一边
			noteModifierKeys(event);
			event.preventDefault();
			event.stopPropagation();
			// 光按 Esc（不带修饰键）= 放弃录制
			if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
				setRecording(null);
				setNotice(null);
				loneCode = null;
				return;
			}
			/**
			 * 只按了一颗修饰键：**先记下，等松手再收**。
			 * 按下就收的话，想录 `右⌘ + L` 的人会先被录成「右⌘」—— 而后者现在是合法的单键绑定。
			 */
			if (isLoneModifierEvent(event)) {
				loneCode = event.code ?? "";
				return;
			}
			loneCode = null;
			const combo = comboFromEvent(event);
			if (!combo) return; // 不支持的键：继续等
			apply(combo);
		};
		/** 松手：如果这一下只按过修饰键，那就是「单键」绑定（右 ⌘ / 右 ⌥ / ⌃ / Alt） */
		const onKeyUp = (event: KeyboardEvent) => {
			noteModifierKeys(event);
			if (loneCode === null || (event.code ?? "") !== loneCode) return;
			loneCode = null;
			event.preventDefault();
			event.stopPropagation();
			const combo = loneModifierCombo(event);
			if (combo) apply(combo);
		};
		/**
		 * 点别处 = 取消录制。两个细节都是踩过的坑：
		 *
		 *  1. **不清那条红字**（`notice`）。它显示在底排上方，一清就会把下面整块上移十几像素，
		 *     `mousedown` 与 `mouseup` 落在不同元素上 → 浏览器根本不发 `click`，
		 *     「恢复默认设置」就成了点了没反应的死按钮。
		 *  2. **点在快捷键行里不抢**：那颗胶囊自己也用 `pointerdown` 前的好奇 ——
		 *     不拦的话，点同一颗胶囊会先被这里取消、再被 `onClick` 重新开录，等于取不了消。
		 */
		const onPointerDown = (event: PointerEvent) => {
			if ((event.target as Element | null)?.closest?.(".shortcut-row")) return;
			setRecording(null);
		};
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [recording, map, save, mac, t]);

	const resetAll = () => {
		setRecording(null);
		setNotice(null);
		save(defaultShortcuts());
	};

	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("快捷键", "Shortcuts")}</span>
				<span className="settings-sub">
					{mac
						? t(
								"macOS：Mod = ⌘；想要真正的 ⌃ 就录 ⌃ + 非字母键（如 ⌃`）",
								"macOS: Mod = ⌘; for a real ⌃ combo record ⌃ plus a non-letter key (e.g. ⌃`)",
							)
						: t("这里写 Ctrl 的地方，macOS 上是 ⌘", "Where it says Ctrl, macOS uses ⌘")}
				</span>
			</div>

			{SHORTCUT_GROUPS.map((group) => {
				const defs = SHORTCUT_DEFS.filter((def) => def.group === group.id);
				if (defs.length === 0) return null;
				return (
					<div className="shortcuts-group" key={group.id}>
						<div className="shortcuts-group-head">{t(group.label, group.labelEn)}</div>
						<div className="shortcuts-list">
				{defs.map((def) => {
					const combo = map[def.id];
					const isRecording = recording === def.id;
					return (
						<div className={`shortcut-row${isRecording ? " shortcut-row-rec" : ""}`} key={def.id}>
							<div className="shortcut-info">
								<span className="shortcut-name">{t(def.label, def.labelEn)}</span>
								{def.hint ? <span className="shortcut-hint">{t(def.hint, def.hintEn ?? def.hint)}</span> : null}
							</div>
							<div className="shortcut-keys">
								<button
									type="button"
									className={`shortcut-combo${isRecording ? " shortcut-combo-rec" : ""}${
										combo ? "" : " shortcut-combo-empty"
									}`}
									aria-label={t(`${def.label} 的快捷键`, `${def.labelEn} shortcut`)}
									onClick={() => {
										setNotice(null);
										setRecording(isRecording ? null : def.id);
									}}
									title={
										isRecording
											? t("按 Esc 取消", "Press Esc to cancel")
											: t(
													"点一下，然后按新的组合键（也可以只按一颗修饰键 / F1–F12）",
													"Click, then press a combo (or a single modifier / F1–F12)",
												)
									}
								>
									{isRecording
										? t("按下组合键 / 单键…", "Press a combo or a single key…")
										: combo
											? formatCombo(combo, mac)
											: t("未设置", "Unbound")}
								</button>
								<button
									type="button"
									className="shortcut-clear"
									disabled={!combo}
									onClick={() => {
										setRecording(null);
										setNotice(null);
										save({ ...map, [def.id]: null });
									}}
									title={t("清除这个快捷键（不设置）", "Clear this shortcut (unbound)")}
									aria-label={t(`清除「${def.label}」的快捷键`, `Clear ${def.labelEn} shortcut`)}
								>
									✕
								</button>
							</div>
						</div>
					);
				})}
						</div>
					</div>
				);
			})}

			{notice ? (
				<div className="shortcut-notice" role="status">
					{notice}
				</div>
			) : null}

			<div className="shortcut-foot">
				<span className="settings-hint">
					{t(
						"组合键要带 ⌘/Ctrl 或 Alt。也可以绑单键：单独一颗修饰键（右⌘ / 右⌥ / ⌃ / Alt）或功能键 F1–F12；裸字母、数字不行（在输入框里打字就会触发动作）。同一组合只能给一个动作。",
						"Combos need ⌘/Ctrl or Alt. Single keys are allowed too: one modifier alone (right ⌘ / right ⌥ / ⌃ / Alt) or a function key F1–F12; bare letters and digits are not (typing would trigger actions). Each combo belongs to one action.",
					)}
				</span>
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => openShortcutSheet()}
					title={t("浮层列出当前所有绑定（也可以按 ⌘/ 打开）", "Lists every binding in an overlay (⌘/ works too)")}
				>
					{t("打开速查表", "Open cheat sheet")}
				</button>
				<button type="button" className="btn btn-tiny" onClick={resetAll}>
					{t("恢复默认设置", "Restore defaults")}
				</button>
			</div>
		</div>
	);
}
