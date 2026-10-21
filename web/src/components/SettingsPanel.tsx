import { useEffect, useState } from "react";
import { setAppState, useAppState } from "../store.ts";
import { setSettings } from "../ws.ts";
import { currentPushState, sendTestPush, subscribePush, unsubscribePush } from "../push.ts";

const DEFAULT_PLACEHOLDER = "继续\n总结一下\n详细解释一下";

/**
 * 设置面板（ADR-0020 §P1）：**内联在侧栏里，不是模态** —— ADR-0013 规定只有审批可以弹模态。
 *
 * 编辑方式刻意用「一行一条」的 textarea：改起来最快，也不用做拖拽排序（ADR-0020 明确后置）。
 * 保存走 `set_settings` → 服务端归一化（≤200 字/条、≤30 条、去空去重）后落盘并推快照。
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

	// ---- 推送订阅（VAPID）----
	const [pushState, setPushState] = useState<string>("…");
	const [pushMsg, setPushMsg] = useState<string | null>(null);
	useEffect(() => {
		void currentPushState()
			.then(setPushState)
			.catch(() => setPushState("unsupported"));
	}, []);

	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>推送通知</span>
				<span className="side-panel-count">{pushState === "subscribed" ? "已订阅" : "未订阅"}</span>
			</div>
			<div className="settings-hint">
				回合结束后推一条到这台设备。需要 <b>https 或 localhost</b>；手机请用域名打开。
			</div>
			<div className="settings-actions">
				<button
					type="button"
					className="btn btn-tiny btn-primary"
					onClick={() => {
						void (async () => {
							const result = await subscribePush();
							setPushMsg(result.ok ? "已订阅，点「测试推送」验一下" : result.message);
							setPushState(await currentPushState());
						})();
					}}
				>
					启用推送
				</button>
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => {
						void (async () => {
							const result = await sendTestPush();
							setPushMsg(`已发送 ${result.sent} 条，失败 ${result.failed} 条`);
						})();
					}}
				>
					测试推送
				</button>
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => {
						void (async () => {
							await unsubscribePush();
							setPushMsg("已取消订阅");
							setPushState(await currentPushState());
						})();
					}}
				>
					取消订阅
				</button>
			</div>
			{pushMsg ? <div className="settings-hint">{pushMsg}</div> : null}

			<div className="settings-head">
				<span>快捷短语</span>
				<button type="button" className="btn btn-tiny" onClick={() => setAppState({ settingsOpen: false })}>
					收起
				</button>
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
				rows={6}
			/>
			<div className="settings-hint">一行一条（最多 30 条，每条 200 字）。改动保存后立即生效。</div>
			<div className="settings-actions">
				<button type="button" className="btn btn-tiny" onClick={save} disabled={!dirty}>
					保存
				</button>
			</div>
		</div>
	);
}
