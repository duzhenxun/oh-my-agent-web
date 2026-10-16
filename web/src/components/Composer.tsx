import { setDraft, useAppState } from "../store.ts";
import { interrupt, sendMessage } from "../ws.ts";

/**
 * 输入区：快捷短语行（ADR-0020 §P1）+ 多行输入框。
 *
 * 快捷短语的交互（与参考实现一致）：
 *   - 点一下 = **直接发送**；
 *   - Shift + 点击 = 只填进输入框（想改一改再发的时候用）。
 * 草稿放在客户端 store 里（ADR-0012 明确：草稿不进快照）。
 */
export function Composer({ running, conversationId }: { running: boolean; conversationId: string | null }) {
	const { draft, snapshot } = useAppState();
	const quickPhrases = snapshot?.settings.quickPhrasesEnabled ? (snapshot?.settings.quickPhrases ?? []) : [];

	const submit = () => {
		const value = draft.trim();
		if (!value || running) return;
		sendMessage(value);
		setDraft("");
	};

	return (
		<div className="composer-wrap">
			{quickPhrases.length > 0 ? (
				<div className="quick-row">
					{quickPhrases.map((phrase) => (
						<button
							type="button"
							key={phrase}
							className="quick-chip"
							disabled={running}
							title={`${phrase}（点击直接发送 · Shift+点击只填入）`}
							onClick={(event) => {
								if (event.shiftKey) {
									setDraft(phrase);
									return;
								}
								if (running) return;
								sendMessage(phrase);
							}}
						>
							{phrase}
						</button>
					))}
				</div>
			) : null}

			<div className="composer">
				<textarea
					className="composer-input"
					value={draft}
					placeholder={running ? "正在跑…（回车排队会被拒绝，先点停止）" : "说点什么，回车发送 · Shift+回车换行"}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						// Enter 发送，Shift+Enter 换行（中文输入法组合期间不触发）
						if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
						event.preventDefault();
						submit();
					}}
					rows={3}
				/>
				<div className="composer-actions">
					{running ? (
						<button type="button" className="btn btn-stop" onClick={() => conversationId && interrupt(conversationId)}>
							停止
						</button>
					) : (
						<button type="button" className="btn btn-send" onClick={submit} disabled={draft.trim().length === 0}>
							发送
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
