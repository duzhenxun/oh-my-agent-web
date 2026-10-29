/**
 * 右侧分栏里的「临时聊天」页。
 *
 * **它就是主对话那一套 UI**（同样的消息气泡、同样的输入框：模型 / 强度 / 想想 /
 * 附件 / 排队 · 插队 · 停止），唯一区别是数据源不是主通道 —— 另外这儿不画
 * 「快捷短语」和「模板」：临时聊天只用来就着选中那段话问一句，用不上那两样。
 *   - 消息区用 `<MessageList>`，喂的是这条通道的快照；
 *   - 输入框用 `<Composer surface={…}>`，`surface` 把「草稿 / 快照 / 发送 / 中断 / 换模型」
 *     接到这条通道上（见 `web/src/chat-surface.ts`）。
 * 以前这里是一套自己写的精简界面（`work-chat-*`），跟主对话越走越不一样 —— 用户要的是
 * "100% 一样，只是不建 session"，所以改成复用组件，而不是继续在样式上对齐。
 *
 * 通道本身见 `web/src/side-chat.ts`：一条标签一条独立 SSE + 独立 clientId，
 * 主聊天那边正在跑什么都不受影响；进来会自动开一条临时会话（不落盘）。
 */
import { useEffect, useMemo, useState } from "react";
import { MessageList } from "./MessageList.tsx";
import { Composer } from "./Composer.tsx";
import { sideChannelFor, type SideState } from "../side-chat.ts";
import type { ChatSurface } from "../chat-surface.ts";
import { useT } from "../use-language.ts";
import { showToast } from "../toast.ts";
import { useSyncExternalStore } from "react";

export function SideChat({ itemId }: { itemId: string }) {
	const t = useT();
	const channel = sideChannelFor(itemId);

	// 通道自带订阅接口（不塞进 React state 的活连接），这里用官方那个外部 store 钩子接上
	const state: SideState = useSyncExternalStore(
		(listener) => channel.subscribe(() => listener()),
		channel.get,
		channel.get,
	);

	// 通道是懒建的：进来先确保有一条临时会话，否则面板上只有一个空壳输入框
	useEffect(() => {
		if (channel.get().snapshot === null) channel.newChat();
	}, [channel]);

	const snapshot = state.snapshot;
	const conversationId = snapshot?.active.conversationId ?? null;
	/**
	 * 这条临时聊天还是「内存里跑」的吗？决定下边那条提示条画不画。
	 *
	 * 两层判断：快照里带了会话清单就以它为准（`ephemeral` 是服务端的事实）；
	 * `slim` 快照经常没有清单，那就退回「这次点过保存」这个本地记忆 ——
	 * 刷新后会退回第一层，最坏的情况只是提示条又来一次（再点一次保存也无害）。
	 */
	const [justSaved, setJustSaved] = useState(false);
	const meta = snapshot?.conversations?.find((item) => item.id === conversationId);
	const ephemeral = conversationId !== null && (meta ? meta.ephemeral === true : !justSaved);
	/**
	 * 有没有「保存为正式对话」这条路：要引擎能把内存会话落成一个真会话文件（`engine.persistSession`）。
	 *
	 * 判据用 `ephemeralChat` 这一位（见 `server/protocol.ts`）：目前只有 pi 声明了它。
	 * codex 没有 —— 它的 thread 一开就已经在 codex 自己库里了，我们既不写盘也不做「转正」，
	 * 那颗按钮点下去只会得到 `engine.unsupported`。所以：**标「不落盘」，但不给保存按钮**，
	 * 而不是留一颗按了报错的按钮让人以为是自己点坏了。
	 */
	const canPersist = snapshot?.engineCapabilities.ephemeralChat === true;
	const messages = snapshot?.active.messages ?? [];
	const running =
		snapshot !== null && snapshot.running.status !== "idle" && snapshot.running.conversationId === conversationId;
	const modelLabels = useMemo(
		() => Object.fromEntries((snapshot?.models ?? []).map((item) => [item.id, item.label])),
		[snapshot?.models],
	);

	/**
	 * 把「主对话要的那几个动作」接到这条通道上。发送时附件 / 排队 / 插队原样转发
	 * （同一条 `send_message` 协议，只是 clientId 不同）；宿主命令（`/new`、`/model`…）不接，
	 * 免得在侧边随手一敲就去动主对话的会话状态。
	 */
	const surface = useMemo<ChatSurface>(
		() => ({
			draft: state.draft ?? "",
			setDraft: channel.setDraft,
			snapshot,
			send: (text, attachments, mode) => {
				channel.send(text, attachments, mode);
				channel.setDraft("");
			},
			interrupt: (id) => channel.interrupt(id),
			switchModel: (modelId) => channel.setModel(modelId),
			hostCommands: false,
		}),
		[state.draft, snapshot, channel],
	);

	return (
		<div className="work-chat work-chat-main">
			<div className="work-chat-stream">
				{messages.length === 0 ? (
					<div className="work-chat-empty">{t("问一句就走：这条聊天不落盘，关掉即消失。")}</div>
				) : (
					<MessageList
						messages={messages}
						hasMoreBefore={false}
						modelLabels={modelLabels}
						workspaceRoot={snapshot?.files?.root ?? null}
						running={running}
						activeTool={running ? (snapshot?.running.activeTool ?? null) : null}
					/>
				)}
			</div>
			{/* 临时聊天提示条：跟主对话那条同一个组件类，说的也是同一件事 ——
			    「只存内存，关掉就没了」，所以必须常驻、不能被滚走，并且就地给一个保存入口。 */}
			{ephemeral ? (
				<div className="ephemeral-banner">
					<span
						className="ephemeral-banner-text"
						title={
							canPersist
								? t(
										"消息只保存在内存里，不落盘、不进历史；关掉标签或重启服务后就没了。",
										"Messages live in memory only: nothing is written to disk, nothing shows up in history, and it is gone once the tab closes or the server restarts.",
									)
								: t(
										"这条聊天不写进本工作台的会话文件、也不进历史，关掉标签或重启服务后就没了。当前引擎没有「转正」能力，所以不提供保存（引擎自己的会话记录由它管理）。",
										"This chat is never written to a workbench session file and never shows up in history; it is gone once the tab closes or the server restarts. The current engine cannot promote it to a saved session, so no save button is offered (the engine keeps its own record).",
									)
						}
					>
						{canPersist
							? t("💬 临时会话：仅存内存，关掉即销毁。", "💬 Temp session: in-memory only, gone on close.")
							: t("💬 临时会话：不落盘，关掉即消失。", "💬 Temp session: never saved, gone on close.")}
					</span>
					{canPersist ? (
						<button
							type="button"
							className="ephemeral-save"
							onClick={() => {
								if (!conversationId) return;
								channel.persist(conversationId);
								setJustSaved(true);
								showToast({ text: t("已保存为正式对话", "Saved as a regular chat"), actions: [] });
							}}
							title={t(
								"把这条聊天写成真正的会话文件（之后就能在历史里找到）",
								"Write this chat to a real session file",
							)}
						>
							💾 {t("保存为正式对话", "Save as a regular chat")}
						</button>
					) : null}
				</div>
			) : null}
			<Composer running={running} conversationId={conversationId} surface={surface} tempChat />
		</div>
	);
}
