/**
 * 可热切换的引擎槽（顶栏「智能体引擎」切换的底座）。
 *
 * 问题：runtime 里的每个模块（会话工厂、模型控制器、审批桥、看门狗、开窗器…）
 * 都在构造时拿到了 `EnginePort` 并闭包持有。要零重启换引擎，只有两条路：
 *   ① 把这些闭包全部重建成「每次取当前引擎」的 getter —— 改动面几十处，容易漏；
 *   ② 给它们一个**稳定的代理对象**，内部指向当前引擎 —— 调用方一行不用改。
 *
 * 这里选 ②：`port` 是恒定的对象，`use()` 之后所有调用都落到新引擎上。
 * 用 Proxy 而不是手写转发，是为了**保留可选方法的语义**：当前引擎没有
 * `switchModel` 时，`engine.switchModel` 就该是 `undefined`（调用方用 `?.` 判断能力），
 * 而不是一个「永远失败的方法」。`in` / `Object.hasOwn` 也照实反映当前引擎。
 */
import type { EnginePort } from "./port.js";

export type SwitchableEngine = {
	/** 恒定引用：传给所有下游模块的就是它 */
	port: EnginePort;
	/** 换掉背后真正的引擎（调用方持有的引用不变） */
	use: (engine: EnginePort) => void;
	/** 当前引擎（诊断 / 需要身份比较时用） */
	current: () => EnginePort;
};

export function createSwitchableEngine(first: EnginePort): SwitchableEngine {
	let current = first;
	const port = new Proxy({} as EnginePort, {
		get(_target, property) {
			const value = (current as unknown as Record<string | symbol, unknown>)[property];
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(current) : value;
		},
		has: (_target, property) => property in (current as unknown as object),
		ownKeys: () => Reflect.ownKeys(current as unknown as object),
		getOwnPropertyDescriptor: (_target, property) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(current as unknown as object, property);
			return descriptor ? { ...descriptor, configurable: true } : undefined;
		},
	});
	return {
		port,
		use: (engine) => {
			current = engine;
		},
		current: () => current,
	};
}
