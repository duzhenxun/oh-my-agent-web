/**
 * 打开 pi 已有的会话（ADR-0021 §2）——从 runtime 拆出（400 行护栏）。
 *
 * 职责很窄但很关键：**把「点开侧栏里的某个历史会话」变成「打开它的文件并读回转录」**。
 * 上下文由会话文件本身提供，所以我们既不用注入历史（ADR-0018 的做法），也不用建自己的转录文件。
 */
import type { EnginePort } from "../engine/port.js";
import type { PiProject, UiMessage } from "../protocol.js";

type PiSessionInfo = { title: string; workspace: string; model?: string | null };

export type PiSessionOpener = {
	/** 新建会话后立即登记（不等扫描）：这样切/发消息马上可用 */
	register: (input: {
		id: string;
		sessionPath: string | null;
		engineSessionId?: string;
		title: string;
		workspace: string;
		model?: string | null;
	}) => void;
	/** 每次扫描后登记「id → 文件路径 / 展示信息」 */
	remember: (projects: PiProject[]) => void;
	isOpen: (conversationId: string) => boolean;
	infoOf: (conversationId: string) => PiSessionInfo | null;
	pathOf: (conversationId: string) => string | null;
	/** 引擎自己的会话句柄（改名 / 删除用）：引擎 id 优先，没有就用文件路径 */
	handleOf: (conversationId: string) => string | null;
	/** 这个项目**最近用过**的模型（新会话拿它当默认；没有会话就 null） */
	projectModel: (workspace: string) => string | null;
	/**
	 * 忘掉一条会话（删除后必须调）：否则 isOpen 仍为 true、infoOf 还查得到，
	 * 用户点进去还能读、还能发消息（引擎里的句柄也还活着）。
	 */
	forget: (conversationId: string) => void;
	/** 切引擎时清空：旧引擎的会话 id / 文件路径对新引擎毫无意义 */
	clear: () => void;
	/** 打开并读回转录；打不开返回 null（调用方负责给用户错误） */
	open: (conversationId: string, refresh: (force?: boolean) => Promise<void>) => Promise<UiMessage[] | null>;
};

type PiSessionOpenerOptions = {
	engine: EnginePort;
	/**
	 * 读到「这个会话用哪个模型」时回调（进快照显示）。
	 * 带上 conversationId：模型是**每个会话一份**，不能只写全局那份
	 * （否则切到别的会话 / 另一个窗口看别的会话，会显示成这里刚读到的模型）。
	 */
	onModel: (model: string, conversationId: string) => void;
	onError: (message: string) => void;
	/**
	 * 这个会话现在是不是还在跑回合。
	 * 正在跑 / 等着审批的会话**永不被回收**：关掉它等于把一轮对话拦腰砍断。
	 */
	isBusy?: (conversationId: string) => boolean;
	/**
	 * 这个会话是不是**只能活在内存里**（临时会话）：这种会话永不能被回收。
	 *
	 * 普通会话关掉句柄还能从文件重新打开，临时会话没有文件 —— 关掉就是真丢了（内容全在内存里），
	 * 用户眼里的「临时对话」也不应该因为多开了几条历史会话就凭空消失。
	 */
	isPinned?: (conversationId: string) => boolean;
	/** 同时保留的引擎会话句柄上限（默认 12） */
	maxOpen?: number;
	/** 被回收时告知调用方（只写日志用） */
	onEvicted?: (conversationId: string) => void;
};

/** 同时保留多少个引擎会话句柄：每个都带一整套 AgentSession + ResourceLoader + 文件句柄 */
const MAX_OPEN_SESSIONS = 12;

export function createPiSessionOpener(options: PiSessionOpenerOptions): PiSessionOpener {
	const pathById = new Map<string, string>();
	/** 引擎自己的会话 id（codex 的 threadId）：跟文件路径并行存，谁有用谁用 */
	const engineIdById = new Map<string, string>();
	const infoById = new Map<string, PiSessionInfo>();
	const opened = new Set<string>();
	/** 打开时间（LRU 回收用；Set 只保证插入顺序，不保证「最近用过」） */
	const lastUsed = new Map<string, number>();
	/** workspace → 该项目最近一个会话用的模型（remember 时按 updatedAt 更新） */
	const modelByWorkspace = new Map<string, { updatedAt: number; model: string }>();

	const touch = (conversationId: string): void => {
		lastUsed.set(conversationId, Date.now());
	};

	/**
	 * 引擎会话句柄的 LRU 回收。
	 *
	 * `opened` 只增不减时，用户连点十几个历史会话，每个都会在引擎里留一整套
	 * AgentSession + ResourceLoader + 文件句柄（端口注释里写的「LRU 回收」其实一直没实现）。
	 *
	 * 回收放在**宿主**这一层而不是引擎里盲淘汰：只有宿主知道哪些会话是「界面认为开着的」。
	 * 在引擎里偷偷关掉一个，宿主还以为它开着 → 下一次发消息就是 `engine.no_session`。
	 * 这里淘汰时同步删掉 `opened`，那次发消息会重新走 `open()`，用户无感（多一次读盘）。
	 */
	const evictIdle = (): void => {
		const limit = options.maxOpen ?? MAX_OPEN_SESSIONS;
		if (opened.size <= limit) return;
		// 正在跑回合 / 等审批的永不动；剩下按「最久没碰过」先淘汰
		const candidates = [...opened]
			.filter((id) => !(options.isBusy?.(id) ?? false) && !(options.isPinned?.(id) ?? false))
			.sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0));
		for (const id of candidates) {
			if (opened.size <= limit) break;
			opened.delete(id);
			lastUsed.delete(id);
			// 只放开引擎句柄：pathById / infoById 都留着（侧栏标题、统计读文件都还要用）
			void Promise.resolve(options.engine.closeSession?.(id)).catch(() => undefined);
			options.onEvicted?.(id);
		}
	};

	/**
	 * 告诉界面「这个会话现在用哪个模型」。
	 * 优先用**这个会话最后一条助手消息**上的模型：那是真的用过的；
	 * `currentModel` 只是进程默认模型（历史会话几乎都对不上，会显示成别的模型）。
	 */
	const announceModel = async (conversationId: string, messages: UiMessage[]): Promise<void> => {
		// ① 会话文件里的最后一次 model_change：用户在选择器上切过也写在这里，最准
		const saved = (await options.engine.sessionModel?.(conversationId)) ?? null;
		if (saved) {
			options.onModel(saved.provider ? `${saved.provider}/${saved.model}` : saved.model, conversationId);
			return;
		}
		// ② 退一步用最后一条助手消息上的模型（它至少是真的用过）
		const used = [...messages].reverse().find((message) => message.role === "assistant" && message.model)?.model;
		if (used) {
			options.onModel(used, conversationId);
			return;
		}
		// 新会话还没有回复：这时进程默认模型就是它接下来要用的
		const current = (await options.engine.currentModel?.(conversationId)) ?? null;
		if (current) {
			options.onModel(current.provider ? `${current.provider}/${current.model}` : current.model, conversationId);
			return;
		}
		// ③ 最后用侧栏清单里记着的模型（dsh 的历史会话在 resume 之前拿不到 config，
		//    但 projcache 里已经有这条会话最后用的模型）
		const known = infoById.get(conversationId)?.model;
		if (known) options.onModel(known, conversationId);
	};

	return {
		register(input) {
			if (input.sessionPath) pathById.set(input.id, input.sessionPath);
			if (input.engineSessionId) engineIdById.set(input.id, input.engineSessionId);
			infoById.set(input.id, { title: input.title, workspace: input.workspace, model: input.model ?? null });
			opened.add(input.id); // createSession 已经把它建好了
		},

		remember(projects) {
			for (const project of projects) {
				for (const session of project.sessions) {
					const workspace = session.cwd || project.cwd;
					if (session.sessionPath) pathById.set(session.id, session.sessionPath);
					if (session.engineSessionId) engineIdById.set(session.id, session.engineSessionId);
					infoById.set(session.id, { title: session.title, workspace, model: session.model ?? null });
					if (!session.model) continue;
					// 只记「这个项目里最新那个会话」的模型：它就是项目的当前口味
					const known = modelByWorkspace.get(workspace);
					if (known && known.updatedAt >= session.updatedAt) continue;
					modelByWorkspace.set(workspace, { updatedAt: session.updatedAt, model: session.model });
				}
			}
		},

		projectModel: (workspace) => modelByWorkspace.get(workspace)?.model ?? null,

		forget: (conversationId) => {
			pathById.delete(conversationId);
			engineIdById.delete(conversationId);
			infoById.delete(conversationId);
			opened.delete(conversationId);
			lastUsed.delete(conversationId);
			// 项目级的「最近用过的模型」不按会话删：它只是新会话的起点，删一条不代表项目口味变了
		},

		clear: () => {
			pathById.clear();
			engineIdById.clear();
			infoById.clear();
			opened.clear();
			lastUsed.clear();
			modelByWorkspace.clear();
		},

		isOpen: (conversationId) => opened.has(conversationId),

		infoOf: (conversationId) => infoById.get(conversationId) ?? null,

		/** 会话文件路径（统计要读它；web 新建的会话也在这里登记过） */
		pathOf: (conversationId: string) => pathById.get(conversationId) ?? null,

		handleOf: (conversationId) => engineIdById.get(conversationId) ?? pathById.get(conversationId) ?? null,

		async open(conversationId, refresh) {
			if (opened.has(conversationId)) {
				// 已经打开过也不能跳过「当前模型」：state.model 是全局一份，
				// 切回来时不重读就会停留在别的会话的模型上（选择器显示错乱）。
				touch(conversationId); // 切回来 = 用过它，LRU 退到最后
				const messages = await options.engine.readUiMessages(conversationId);
				await announceModel(conversationId, messages);
				return messages;
			}

			const handle = () => engineIdById.get(conversationId) ?? pathById.get(conversationId) ?? "";
			let found = handle();
			if (found === "") {
				await refresh(true); // 可能是刚建的会话，刷新一次再找
				found = handle();
			}
			if (found === "") return null;

			try {
				const engineSessionId = engineIdById.get(conversationId);
				const sessionPath = pathById.get(conversationId);
				await options.engine.openSession({
					sessionId: conversationId,
					...(engineSessionId ? { engineSessionId } : {}),
					...(sessionPath ? { sessionPath } : {}),
					...(infoById.get(conversationId)?.workspace ? { cwd: infoById.get(conversationId)?.workspace } : {}),
				});
			} catch (error) {
				options.onError(`打开会话失败：${error instanceof Error ? error.message : String(error)}`);
				return null;
			}
			opened.add(conversationId);
			touch(conversationId);
			evictIdle();
			const messages = await options.engine.readUiMessages(conversationId);
			await announceModel(conversationId, messages);
			return messages;
		},
	};
}
