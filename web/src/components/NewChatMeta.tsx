/**
 * 新会话（还没有消息时）抬头：图标 + 名字 + 版本号 + 一句招呼，紧贴输入框上方。
 *
 * 为什么放这儿而不是放大片空白里：这是「准备开聊」的那一刻，人要看的信息就这几样 ——
 * 「这是哪个工具」「什么版本」「现在能干什么」。放在输入框上方，视线不用来回跑；
 * 消息一多这行就自动消失（不长期占地方）。
 *
 * 排版：左图右文（名字大字、版本号小字）；招呼语不在这里 —— 它居中放在对话区
 * （见 App.tsx 的 `.chat-greeting`）。
 */
export function NewChatMeta({
	webVersion,
	engineName,
	engineVersion,
}: {
	webVersion: string;
	/** 引擎名：`pi` / `fake` */
	engineName: string;
	engineVersion: string | null;
}) {
	return (
		<div className="newchat-meta">
			<div className="newchat-brand">
				<img className="newchat-icon" src="/favicon.svg" alt="" aria-hidden="true" />
				<div className="newchat-brand-text">
					<span className="newchat-name">Agent Web</span>
					<span className="newchat-versions mono">
						web v{webVersion} · {engineName}
						{engineVersion ? ` v${engineVersion}` : ""}
					</span>
				</div>
			</div>
		</div>
	);
}
