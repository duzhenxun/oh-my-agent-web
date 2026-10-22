import { useEffect, useState } from "react";
import { useAppState } from "../store.ts";
import { setSettings } from "../ws.ts";

const DEFAULT_PLACEHOLDER = "继续\n总结一下\n详细解释一下";

/**
 * 设置面板（ADR-0020 §P1）：**内联在侧栏里，不是模态** —— ADR-0013 规定只有审批可以弹模态。
 *
 * 两块设置，各管各的保存按钮：
 *   1. 快捷短语 —— 「一行一条」的 textarea，改起来最快，也不用做拖拽排序（ADR-0020 明确后置）；
 *   2. 想想     —— 「下一步建议」一次生成几条 + 隐藏回合最多等多久。
 * 保存都走 `set_settings` → 服务端归一化（长度 / 条数 / 上下限）后落盘并推快照。
 */
export function SettingsPanel() {
	const { snapshot } = useAppState();
	const [text, setText] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [dirty, setDirty] = useState(false);

	const phrases = snapshot?.settings.quickPhrases ?? [];
	const phrasesEnabled = snapshot?.settings.quickPhrasesEnabled ?? true;

	// 打开面板时用当前设置初始化；服务端推回新设置时若用户没在编辑，就跟着更新
	useEffect(() => {
		if (dirty) return;
		setText(phrases.join("\n"));
		setEnabled(phrasesEnabled);
	}, [phrases, phrasesEnabled, dirty]);

	const save = () => {
		setSettings({
			quickPhrases: text.split("\n"),
			quickPhrasesEnabled: enabled,
		});
		setDirty(false);
	};

	// ---- 想想 ----
	const thinkCount = snapshot?.settings.thinkCount ?? 5;
	const thinkTimeoutSec = snapshot?.settings.thinkTimeoutSec ?? 20;
	const [thinkDraft, setThinkDraft] = useState({ count: thinkCount, timeoutSec: thinkTimeoutSec });
	const [thinkDirty, setThinkDirty] = useState(false);

	useEffect(() => {
		if (thinkDirty) return;
		setThinkDraft({ count: thinkCount, timeoutSec: thinkTimeoutSec });
	}, [thinkCount, thinkTimeoutSec, thinkDirty]);

	const saveThink = () => {
		setSettings({ thinkCount: thinkDraft.count, thinkTimeoutSec: thinkDraft.timeoutSec });
		setThinkDirty(false);
	};

	return (
		<div className="settings-stack">
			<div className="settings-panel">
				<div className="settings-head">
					<span>快捷短语</span>
					<span className="settings-sub">输入框上方那一排按钮</span>
				</div>
				<label className="settings-toggle">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(event) => {
							setEnabled(event.target.checked);
							setDirty(true);
						}}
					/>
					在输入框上方显示
				</label>
				<textarea
					className="settings-textarea"
					value={text}
					placeholder={DEFAULT_PLACEHOLDER}
					onChange={(event) => {
						setText(event.target.value);
						setDirty(true);
					}}
					rows={5}
				/>
				<div className="settings-hint">一行一条（最多 30 条，每条 200 字）。改动保存后立即生效。</div>
				<div className="settings-actions">
					<button type="button" className="btn btn-tiny" onClick={save} disabled={!dirty}>
						保存
					</button>
				</div>
			</div>

			<div className="settings-panel">
				<div className="settings-head">
					<span>想想</span>
					<span className="settings-sub">下一步建议</span>
				</div>
				<div className="settings-row">
					<label className="settings-field">
						<span>一次生成</span>
						<input
							className="settings-number"
							type="number"
							inputMode="numeric"
							min={1}
							max={5}
							value={thinkDraft.count}
							onChange={(event) => {
								const value = Number(event.target.value);
								if (!Number.isFinite(value)) return;
								setThinkDraft((draft) => ({ ...draft, count: Math.min(5, Math.max(1, Math.round(value))) }));
								setThinkDirty(true);
							}}
						/>
						<span>条</span>
					</label>
					<label className="settings-field">
						<span>最多等</span>
						<input
							className="settings-number"
							type="number"
							inputMode="numeric"
							min={5}
							max={180}
							step={5}
							value={thinkDraft.timeoutSec}
							onChange={(event) => {
								const value = Number(event.target.value);
								if (!Number.isFinite(value)) return;
								setThinkDraft((draft) => ({
									...draft,
									timeoutSec: Math.min(180, Math.max(5, Math.round(value))),
								}));
								setThinkDirty(true);
							}}
						/>
						<span>秒</span>
					</label>
				</div>
				<div className="settings-hint">
					「想想」用一次隐藏回合让模型出建议（不进对话）。超过这个时间还没出结果就中断，可以再点一次。
				</div>
				<div className="settings-actions">
					<button type="button" className="btn btn-tiny" onClick={saveThink} disabled={!thinkDirty}>
						保存
					</button>
				</div>
			</div>
		</div>
	);
}
