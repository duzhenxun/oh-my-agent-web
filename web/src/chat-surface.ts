/**
 * 「一个聊天面」的最小接口：Composer（以及将来的消息区）只认这几个动作，不认全局 store。
 *
 * 为什么要有：右侧「临时聊天」要求**跟主对话长得一模一样**（同样的消息气泡、同样的
 * 模型 / 想想 / 附件 / 排队插队那一整排；快捷短语和模板两样例外，那边不画），
 * 唯一区别是它不发主通道、
 * 也不建 session。以前 SideChat 是另写的一套精简界面（自己一套 `work-chat-*` 样式），
 * 于是两边越走越不一样。
 *
 * 现在把「输入框 + 消息」需要的几个原语抽成这个接口，由两个实现喂：
 *   - 主对话：`useAppState()` + `ws.ts`（见 Composer 里的默认实现）；
 *   - 临时聊天：`web/src/side-chat.ts` 那条独立通道（见 SideChat）。
 * 组件本身不关心是哪一个，于是同一份 UI 两边通用。
 */
import type { Snapshot } from "./types.ts";
import type { AttachmentRef } from "./types.ts";

/** 跟 `ws.ts` 的 SendMode 一致：直接发 / 排队 / 插队 */
type SurfaceSendMode = "now" | "queue" | "steer";

export type ChatSurface = {
	/** 输入框里的草稿（受控） */
	draft: string;
	setDraft: (draft: string) => void;
	/** 这一面自己的那一份快照（模型表 / 设置 / 会话内容都从这儿来） */
	snapshot: Snapshot | null;
	send: (text: string, attachments: AttachmentRef[] | undefined, mode: SurfaceSendMode) => void;
	interrupt: (conversationId: string) => void;
	/** 换模型。主对话走全局通道、临时聊天走它自己那条（服务端的模型是引擎级的，两边同源） */
	switchModel: (modelId: string) => void;
	/**
	 * 写「项目默认模型」。临时聊天没有这个概念 —— 不传就只是这一面不落这个偏好，
	 * 不会去改主对话的设置。
	 */
	setProjectDefaultModel?: (projectRoot: string, modelId: string | null) => void;
	/**
	 * 这一面要不要自己处理 `/xxx` 这类**宿主命令**（新建会话、改名、切模型…）。
	 * 主对话要；临时聊天不该动主對話的会话状态，所以传 false（命令原样发给引擎）。
	 */
	hostCommands?: boolean;
};
