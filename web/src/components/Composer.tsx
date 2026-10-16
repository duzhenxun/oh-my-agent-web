import { useState, type KeyboardEvent } from "react";
import { interrupt, sendMessage } from "../ws.ts";

export function Composer({ running, conversationId }: { running: boolean; conversationId: string | null }) {
	const [text, setText] = useState("");

	const submit = () => {
		const value = text.trim();
		if (!value || running) return;
		sendMessage(value);
		setText("");
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		// Enter 发送，Shift+Enter 换行（中文输入法的组合期间不触发，交给 IME 处理）
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		submit();
	};

	return (
		<div className="composer">
			<textarea
				className="composer-input"
				value={text}
				placeholder={running ? "正在跑…（回车排队会被拒绝，先点停止）" : "说点什么，回车发送 · Shift+回车换行"}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={onKeyDown}
				rows={3}
			/>
			<div className="composer-actions">
				{running ? (
					<button type="button" className="btn btn-stop" onClick={() => conversationId && interrupt(conversationId)}>
						停止
					</button>
				) : (
					<button type="button" className="btn btn-send" onClick={submit} disabled={text.trim().length === 0}>
						发送
					</button>
				)}
			</div>
		</div>
	);
}
