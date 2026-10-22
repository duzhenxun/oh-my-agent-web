/**
 * 切引擎（顶栏「智能体引擎」面板的后端）：**零重启**换掉 agent 运行时。
 *
 * 一次切换要同时换三样东西，少一样就会出现「界面是新引擎、数据是旧引擎」：
 *   1. **引擎实例**（`SwitchableEngine.use`）—— 下层模块持有的是稳定代理，不用重建；
 *   2. **引擎作用域的状态** —— 会话、消息、模型、思考档位、审批弹窗、项目清单、
 *      provider 表**全部是某个引擎的**，跨引擎复用没有意义（pi 的会话 id 到 codex 一文不值）；
 *   3. **会话清单来源 + 审批处理器** —— 前者从目录换，后者要重新挂到新引擎上。
 *
 * 为什么回合在飞时直接拒绝：一个回合的工具调用、审批、落盘全是旧引擎的语义，
 * 半途换引擎只会产生一份谁也解释不清的会话。宁可让用户先中断（前端会给出提示）。
 *
 * 单独一个文件是为了 400 行护栏（ADR-0010）：runtime.ts 已经贴着上限。
 */
import type { EngineEntry } from "../engine/catalog.js";
import type { EngineDescriptor } from "../engine/registry.js";
import type { ApprovalHandler, EnginePort } from "../engine/port.js";
import type { EngineOption, PiProject, ProviderView } from "../protocol.js";
import { emptyRunning, type ServerState } from "../snapshot/state.js";
import type { ClientView } from "./client-view.js";

export type EngineSwitchResult = { ok: true } | { ok: false; error: { code: string; message: string } };

export type EngineSwitchDeps = {
	state: ServerState;
	/** 可热替换的引擎槽（下游模块持有的是它的代理） */
	slot: { use: (engine: EnginePort) => void; current: () => EnginePort };
	/** 引擎目录；不给 = 只有当前这一个引擎（单测 / 最小启动） */
	engines: {
		get: (name: string) => EngineEntry | null;
		descriptors: () => EngineDescriptor[];
		sessionsFor: (name: string) => (() => Promise<PiProject[]>) | null;
	} | null;
	/** runtime 里「当前会话清单来源」的可变槽：切换后就地换掉，不需要重建 refresher */
	sessionsSlot: { current: (() => Promise<PiProject[]>) | null };
	clientView: Pick<ClientView, "reset">;
	/** pi 的会话路径表：换引擎必须清空 */
	clearSessions: () => void;
	/** 审批处理器（要重新挂到新引擎上；旧引擎那份已经没用了） */
	approvalHandler: ApprovalHandler;
	/** 重读模型表（prewarm + reload + listModels） */
	refreshModels: () => Promise<void>;
	/** 重扫历史会话（force = 忽略最小间隔） */
	refreshSessions: (force?: boolean) => Promise<void>;
	/** provider 配置（只有自管配置的引擎才有；别的引擎返回 null） */
	loadProviders: (() => Promise<ProviderView[]>) | null;
	isBusy: () => boolean;
	notice: (text: string, level: "info" | "warn" | "error") => void;
	pushSnapshot: () => void;
};

/**
 * 注册项 → 快照里的可选引擎（badge 缺省用大写名字）。
 * `active` 用来兜底：当前引擎即使标了 hidden（比如测试用的 fake）也要出现在列表里。
 */
export function engineOptions(descriptors: EngineDescriptor[], active?: string): EngineOption[] {
	return descriptors
		.filter((descriptor) => descriptor.hidden !== true || descriptor.name === active)
		.map((descriptor) => ({
			name: descriptor.name,
			label: descriptor.label,
			badge: descriptor.badge ?? descriptor.name.toUpperCase(),
			description: descriptor.description ?? "",
			capabilities: { ...descriptor.capabilities },
		}));
}

/**
 * 快照里的引擎清单：有目录就用目录的全部注册项；没有目录（单测 / 最小启动）
 * 就退化成「只有当前这一个」，切换请求会被拒 —— 界面不会出现一个点不动的列表。
 */
export function engineOptionsFor(
	name: string,
	capabilities: EngineOption["capabilities"],
	descriptors?: EngineDescriptor[],
): EngineOption[] {
	if (descriptors) return engineOptions(descriptors, name);
	return [
		{
			name,
			label: name,
			badge: name.toUpperCase(),
			description: "",
			capabilities: { ...capabilities },
		},
	];
}

export function createEngineSwitcher(deps: EngineSwitchDeps): (name: string) => Promise<EngineSwitchResult> {
	const { state } = deps;

	/**
	 * 清掉「属于某个引擎」的状态。
	 * 刻意**保留**的东西：approvalMode（宿主策略，不是引擎的）、settings（客户端偏好）、
	 * workspace（目录）、terminal/files（那是磁盘与 PTY，跟引擎无关）。
	 */
	const clearEngineScopedState = (): void => {
		state.conversations = [];
		state.messages = {};
		state.activeId = null;
		state.queued = [];
		state.running = emptyRunning();
		state.runningByConversation = {};
		state.statsByConversation = {};
		state.sessionStats = null;
		state.models = [];
		state.model = null;
		state.thinkingLevel = null;
		state.thinkingLevels = [];
		state.pendingApproval = null;
		state.actions = [];
		state.notices = [];
		state.piProjects = [];
		state.piProjectsVersion += 1; // 清单变了 → 下一帧必须带上（不能沿用旧引擎的那份）
		state.providers = [];
		state.enabledModels = [];
	};

	return async (name) => {
		if (deps.isBusy()) {
			return { ok: false, error: { code: "engine.busy", message: "还有回合在跑，先等它结束或中断再切引擎" } };
		}
		const entry = deps.engines?.get(name) ?? null;
		if (!entry) {
			return { ok: false, error: { code: "engine.unknown", message: `没有这个引擎：${name}` } };
		}
		if (entry.descriptor.name === state.engine) return { ok: true };

		// 先收掉旧引擎的外部资源（codex：关 app-server → 释放它持有的全部写锁），
		// 再换指针。收不掉也不影响切换本身。
		const previousEngine = deps.slot.current();
		if (previousEngine !== entry.engine) {
			await Promise.resolve(previousEngine.dispose?.()).catch(() => undefined);
		}
		deps.slot.use(entry.engine);
		state.engine = entry.descriptor.name;
		state.engineCapabilities = { ...entry.descriptor.capabilities };
		state.engines = engineOptionsFor(
			entry.descriptor.name,
			entry.descriptor.capabilities,
			deps.engines?.descriptors(),
		);
		state.versions = { ...state.versions, engine: entry.engine.version?.() ?? null };
		clearEngineScopedState();
		deps.clientView.reset();
		deps.clearSessions();
		deps.sessionsSlot.current = deps.engines?.sessionsFor(entry.descriptor.name) ?? null;
		entry.engine.setApprovalHandler(deps.approvalHandler);

		// 先推一帧「已经切过去、还是空的」：前端立刻把侧栏与模型换掉，不用等扫描
		deps.pushSnapshot();

		try {
			await deps.refreshModels();
			// 懒启动的引擎（codex/dsh）在 refreshModels 里才真正连上 → 版本号这时才有
			state.versions = { ...state.versions, engine: entry.engine.version?.() ?? null };
			if (entry.descriptor.providerConfig !== false && deps.loadProviders) {
				state.providers = await deps.loadProviders();
			}
		} catch (error) {
			deps.notice(`切换后加载模型失败：${error instanceof Error ? error.message : String(error)}`, "warn");
		}
		deps.pushSnapshot();
		await deps.refreshSessions(true).catch((error) => {
			deps.notice(`读取历史会话失败：${error instanceof Error ? error.message : String(error)}`, "warn");
		});
		deps.notice(`已切换到 ${entry.descriptor.label}`, "info");
		return { ok: true };
	};
}
