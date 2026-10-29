/**
 * 子代理桥（宿主侧）：引擎的运行记录 → 服务端状态 → 快照。
 *
 * 分工纪律（和审批桥 / 模型控制器一致）：
 *   - 引擎只知道「跑了什么、什么时候跑完」；
 *   - 宿主决定「面板上显示哪些、并发上限是多少、模板存在哪」；
 *   - 快照只带**当前会话**的运行记录（别的会话的子代理不该占这一帧的体积）。
 *
 * 模板与开关落 `~/.pi/agent/agents`（见 subagents/profile-store.ts）：
 * 面板改完立刻对**新建的**子代理生效（已经在跑的不动）。
 */
import type { SubagentProfileView, SubagentRunView, SubagentSettingsView } from "../protocol.js";
import type { EnginePort } from "../engine/port.js";
import type { ServerState } from "../snapshot/state.js";
import {
	deleteSubagentProfile,
	listSubagentProfileViews,
	readSubagentSettings,
	saveSubagentProfile,
	writeSubagentSettings,
} from "../subagents/profile-store.js";

type SubagentBridge = {
	/** 读模板 + 开关；订阅当前引擎的运行事件（建 runtime 时调一次） */
	init(): void;
	/** 切引擎之后：旧引擎的子代理已经作废，重新订阅新引擎 */
	engineChanged(): void;
	/** 把当前会话的子代理全部停掉（删会话 / 关引擎时用） */
	stopAll(conversationId: string): Promise<void>;
	interrupt(runId: string): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>;
	saveProfile(
		profile: SubagentProfileView,
	): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>;
	deleteProfile(profileId: string): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>;
	applySettings(
		patch: Partial<SubagentSettingsView>,
	): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>;
	/** 只刷新模板与开关（外部改了 md 文件时用） */
	reload(): void;
	dispose(): void;
};

type Result = { ok: true } | { ok: false; error: { code: string; message: string } };

function fail(code: string, message: string): Result {
	return { ok: false, error: { code, message } };
}

/** 保留最近多少条运行记录（面板要「刚才那个跑完了」这类上下文，但不要无限涨） */
const KEEP_PER_CONVERSATION = 30;

export function createSubagentBridge(options: {
	agentDir: string;
	/** 可热切换的引擎代理：切引擎后 `engine.subagents` 指向新引擎 */
	engine: EnginePort;
	state: ServerState;
	pushSnapshot: () => void;
	/** 子代理失败时给界面一条提示（面板关着也看得见） */
	onNotice?: (text: string, level: "info" | "warn" | "error") => void;
}): SubagentBridge {
	const { state } = options;
	let unsubscribe: (() => void) | null = null;

	const reload = (): void => {
		state.subagentProfiles = listSubagentProfileViews(options.agentDir);
		state.subagentSettings = readSubagentSettings(options.agentDir);
		const port = options.engine.subagents;
		port?.setConcurrency(state.subagentSettings.enabled ? state.subagentSettings.concurrency : 1);
		// 引擎能真正关掉委派时（codex）就把开关传下去：面格里「关掉」= 模型没有这个工具
		port?.setEnabled?.(state.subagentSettings.enabled);
	};

	/** 一条运行记录的变化：按会话落进 state，只保留最近 N 条 */
	const applyRun = (run: SubagentRunView): void => {
		const list = state.subagentsByConversation[run.conversationId] ?? [];
		const previous = list.find((item) => item.id === run.id);
		// 只在「刚变成失败」的那一下提示一次（之后的进度帧不再重复）
		if (run.status === "failed" && previous?.status !== "failed") {
			options.onNotice?.(`子代理「${run.label}」失败：${run.error ?? "未知错误"}`, "warn");
		}
		const next = [run, ...list.filter((item) => item.id !== run.id)].slice(0, KEEP_PER_CONVERSATION);
		state.subagentsByConversation = { ...state.subagentsByConversation, [run.conversationId]: next };
		options.pushSnapshot();
	};

	const attach = (): void => {
		unsubscribe?.();
		unsubscribe = null;
		const port = options.engine.subagents;
		// 引擎没有子代理也要读模板：面板要能看见并管理那 3 个内置模板（只是跑不了）
		if (!port) {
			reload();
			options.pushSnapshot();
			return;
		}
		unsubscribe = port.subscribe(applyRun);
		reload();
		options.pushSnapshot();
	};

	return {
		init() {
			reload();
			attach();
		},

		engineChanged() {
			// 换引擎：旧引擎的子代理不会再推事件，画面上留着只会误导
			state.subagentsByConversation = {};
			attach();
		},

		async stopAll(conversationId) {
			const list = state.subagentsByConversation[conversationId] ?? [];
			for (const run of list) {
				if (run.status !== "running" && run.status !== "queued") continue;
				await options.engine.subagents?.interrupt(run.id).catch(() => undefined);
			}
			const { [conversationId]: _dropped, ...rest } = state.subagentsByConversation;
			state.subagentsByConversation = rest;
		},

		async interrupt(runId) {
			const port = options.engine.subagents;
			if (!port) return fail("subagent.unsupported", "当前引擎没有子代理");
			const known = Object.values(state.subagentsByConversation)
				.flat()
				.some((run) => run.id === runId);
			if (!known) return fail("subagent.not_found", `没有这个子代理：${runId}`);
			await port.interrupt(runId);
			return { ok: true };
		},

		async saveProfile(profile) {
			if (!options.engine.subagents) return fail("subagent.unsupported", "当前引擎没有子代理");
			try {
				saveSubagentProfile(options.agentDir, profile);
			} catch (error) {
				return fail("subagent.invalid_profile", error instanceof Error ? error.message : String(error));
			}
			reload();
			options.pushSnapshot();
			return { ok: true };
		},

		async deleteProfile(profileId) {
			if (!options.engine.subagents) return fail("subagent.unsupported", "当前引擎没有子代理");
			try {
				deleteSubagentProfile(options.agentDir, profileId);
			} catch (error) {
				return fail("subagent.delete_failed", error instanceof Error ? error.message : String(error));
			}
			reload();
			options.pushSnapshot();
			return { ok: true };
		},

		async applySettings(patch) {
			try {
				state.subagentSettings = writeSubagentSettings(options.agentDir, patch);
			} catch (error) {
				return fail("subagent.settings_failed", error instanceof Error ? error.message : String(error));
			}
			reload();
			options.pushSnapshot();
			return { ok: true };
		},

		reload,

		dispose() {
			unsubscribe?.();
			unsubscribe = null;
		},
	};
}
