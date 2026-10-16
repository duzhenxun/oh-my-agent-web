/**
 * 打开 pi 已有的会话（ADR-0021 §2）——从 runtime 拆出（400 行护栏）。
 *
 * 职责很窄但很关键：**把「点开侧栏里的某个历史会话」变成「打开它的文件并读回转录」**。
 * 上下文由会话文件本身提供，所以我们既不用注入历史（ADR-0018 的做法），也不用建自己的转录文件。
 */
import type { EnginePort } from "../engine/port.js";
import type { PiProject, UiMessage } from "../protocol.js";

export type PiSessionInfo = { title: string; workspace: string };

export type PiSessionOpener = {
	/** 新建会话后立即登记（不等扫描）：这样切/发消息马上可用 */
	register: (input: { id: string; sessionPath: string | null; title: string; workspace: string }) => void;
	/** 每次扫描后登记「id → 文件路径 / 展示信息」 */
	remember: (projects: PiProject[]) => void;
	isOpen: (conversationId: string) => boolean;
	infoOf: (conversationId: string) => PiSessionInfo | null;
	/** 打开并读回转录；打不开返回 null（调用方负责给用户错误） */
	open: (conversationId: string, refresh: (force?: boolean) => Promise<void>) => Promise<UiMessage[] | null>;
};

export type PiSessionOpenerOptions = {
	engine: EnginePort;
	/** 读到模型时回调（进快照显示） */
	onModel: (model: string) => void;
	onError: (message: string) => void;
};

export function createPiSessionOpener(options: PiSessionOpenerOptions): PiSessionOpener {
	const pathById = new Map<string, string>();
	const infoById = new Map<string, PiSessionInfo>();
	const opened = new Set<string>();

	return {
		register(input) {
			if (input.sessionPath) pathById.set(input.id, input.sessionPath);
			infoById.set(input.id, { title: input.title, workspace: input.workspace });
			opened.add(input.id); // createSession 已经把它建好了
		},

		remember(projects) {
			for (const project of projects) {
				for (const session of project.sessions) {
					pathById.set(session.id, session.sessionPath);
					infoById.set(session.id, { title: session.title, workspace: session.cwd || project.cwd });
				}
			}
		},

		isOpen: (conversationId) => opened.has(conversationId),

		infoOf: (conversationId) => infoById.get(conversationId) ?? null,

		async open(conversationId, refresh) {
			if (opened.has(conversationId)) return options.engine.readUiMessages(conversationId);

			let sessionPath = pathById.get(conversationId) ?? "";
			if (sessionPath === "") {
				await refresh(true); // 可能是刚建的会话，刷新一次再找
				sessionPath = pathById.get(conversationId) ?? "";
			}
			if (sessionPath === "") return null;

			try {
				await options.engine.openSession({ sessionId: conversationId, sessionPath });
			} catch (error) {
				options.onError(`打开会话失败：${error instanceof Error ? error.message : String(error)}`);
				return null;
			}
			opened.add(conversationId);
			const messages = await options.engine.readUiMessages(conversationId);
			const model = (await options.engine.currentModel?.(conversationId)) ?? null;
			if (model) options.onModel(`${model.provider}/${model.model}`);
			return messages;
		},
	};
}
