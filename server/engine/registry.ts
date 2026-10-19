/**
 * 引擎注册表（ADR-0024）：把「有哪些引擎可选」与「引擎各自能干到什么程度」集中到一处。
 *
 * 目标：加一个新引擎 = 写一个适配文件 + 在这里注册一行，
 * 而不是去 index / runtime / 前端各处改 if/else。
 *
 * 纪律：
 *   - 每个引擎的 SDK / 子进程只允许出现在它自己的适配文件里，引擎之间不得互相 import；
 *   - 能力矩阵必须**如实**声明：没有的写着 false，界面据此隐藏按钮，绝不假装能拦。
 */
import type { EnginePort } from "./port.js";

/** 引擎能力（ADR-0024 §2）：决定界面上哪些控件出现 */
export type EngineCapabilities = {
	/** 危险操作能不能在界面里拦住并问用户 */
	approvals: boolean;
	/** 有没有工具调用（卡片展示） */
	tools: boolean;
	/** 能不能切模型 */
	modelSwitch: boolean;
	/** 有没有「思考强度」 */
	thinkingLevel: boolean;
	/** 能不能续上历史会话 */
	resume: boolean;
};

export type EngineDescriptor = {
	/** 注册名，也就是 AGENT_WEB_ENGINE 的取值 */
	name: string;
	/** 界面显示名 */
	label: string;
	capabilities: EngineCapabilities;
	create: () => EnginePort;
};

export type EngineRegistry = {
	/** 已注册的引擎名（给错误信息与调试用） */
	names: () => string[];
	/** 按名字取引擎；未知名字回落到 fallback（默认 pi），并报告这件事 */
	resolve: (name: string) => { engine: EnginePort; descriptor: EngineDescriptor; fallbackFrom: string | null };
	/** 按名字取能力矩阵；未知名字回落 */
	capabilitiesOf: (name: string) => EngineCapabilities;
};

const ALL_ON: EngineCapabilities = {
	approvals: true,
	tools: true,
	modelSwitch: true,
	thinkingLevel: true,
	resume: true,
};

export function createEngineRegistry(descriptors: EngineDescriptor[], fallbackName = "pi"): EngineRegistry {
	const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
	const fallback = byName.get(fallbackName) ?? descriptors[0];
	if (!fallback) throw new Error("引擎注册表为空（至少要注册一个引擎）");

	return {
		names: () => [...byName.keys()],
		resolve(name) {
			const found = byName.get(name);
			if (found) return { engine: found.create(), descriptor: found, fallbackFrom: null };
			return { engine: fallback.create(), descriptor: fallback, fallbackFrom: name };
		},
		capabilitiesOf: (name) => (byName.get(name) ?? fallback).capabilities,
	};
}

/** 假引擎的能力：**没有审批**（它只是剧本，不需要拦），其余从简 */
export const FAKE_CAPABILITIES: EngineCapabilities = {
	approvals: true, // 假引擎仍会走审批剧本（approve 触发词），保留 true 便于测试
	tools: true,
	modelSwitch: true,
	thinkingLevel: false,
	resume: true,
};

export const PI_CAPABILITIES: EngineCapabilities = ALL_ON;
