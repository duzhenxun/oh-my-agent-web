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
	pathOf: (conversationId: string) => string | null;
	/** 这个项目**最近用过**的模型（新会话拿它当默认；没有会话就 null） */
	projectModel: (workspace: string) => string | null;
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
	/** workspace → 该项目最近一个会话用的模型（remember 时按 updatedAt 更新） */
	const modelByWorkspace = new Map<string, { updatedAt: number; model: string }>();

	/**
	 * 告诉界面「这个会话现在用哪个模型」。
	 * 优先用**这个会话最后一条助手消息**上的模型：那是真的用过的；
	 * `currentModel` 只是进程默认模型（历史会话几乎都对不上，会显示成别的模型）。
	 */
	const announceModel = async (conversationId: string, messages: UiMessage[]): Promise<void> => {
		// ① 会话文件里的最后一次 model_change：用户在选择器上切过也写在这里，最准
		const saved = (await options.engine.sessionModel?.(conversationId)) ?? null;
		if (saved) {
			options.onModel(`${saved.provider}/${saved.model}`);
			return;
		}
		// ② 退一步用最后一条助手消息上的模型（它至少是真的用过）
		const used = [...messages].reverse().find((message) => message.role === "assistant" && message.model)?.model;
		if (used) {
			options.onModel(used);
			return;
		}
		// 新会话还没有回复：这时进程默认模型就是它接下来要用的
		const current = (await options.engine.currentModel?.(conversationId)) ?? null;
		if (current) options.onModel(`${current.provider}/${current.model}`);
	};

	return {
		register(input) {
			if (input.sessionPath) pathById.set(input.id, input.sessionPath);
			infoById.set(input.id, { title: input.title, workspace: input.workspace });
			opened.add(input.id); // createSession 已经把它建好了
		},

		remember(projects) {
			for (const project of projects) {
				for (const session of project.sessions) {
					const workspace = session.cwd || project.cwd;
					pathById.set(session.id, session.sessionPath);
					infoById.set(session.id, { title: session.title, workspace });
					if (!session.model) continue;
					// 只记「这个项目里最新那个会话」的模型：它就是项目的当前口味
					const known = modelByWorkspace.get(workspace);
					if (known && known.updatedAt >= session.updatedAt) continue;
					modelByWorkspace.set(workspace, { updatedAt: session.updatedAt, model: session.model });
				}
			}
		},

		projectModel: (workspace) => modelByWorkspace.get(workspace)?.model ?? null,

		isOpen: (conversationId) => opened.has(conversationId),

		infoOf: (conversationId) => infoById.get(conversationId) ?? null,

		/** 会话文件路径（统计要读它；web 新建的会话也在这里登记过） */
		pathOf: (conversationId: string) => pathById.get(conversationId) ?? null,

		async open(conversationId, refresh) {
			if (opened.has(conversationId)) {
				// 已经打开过也不能跳过「当前模型」：state.model 是全局一份，
				// 切回来时不重读就会停留在别的会话的模型上（选择器显示错乱）。
				const messages = await options.engine.readUiMessages(conversationId);
				await announceModel(conversationId, messages);
				return messages;
			}

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
			await announceModel(conversationId, messages);
			return messages;
		},
	};
}
