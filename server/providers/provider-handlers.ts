/**
 * provider 请求的处理（从 index.ts 抽出来：400 行护栏，ADR-0010）。
 *
 * 保持极简：校验 → 写盘 → 用提示条回传结果（前端没有 request/response 配对机制）。
 */
import type { UpsertProviderRequest } from "../protocol.js";
import type { ProviderStore } from "./provider-store.js";
import { validateProviderInput } from "./validate.js";

export type ProviderHandlerDeps = {
	store: ProviderStore;
	/** 给界面推一条提示（成功/失败都用它回传结果） */
	notify: (text: string, level: "info" | "warn" | "error") => void;
	logInfo: (message: string, meta?: Record<string, unknown>) => void;
	/** 测试连通性时要读明文 key（只在这一处、只用于发出请求，不返回给界面） */
	readKey: (provider: string) => Promise<string | null>;
	probe: (options: {
		baseUrl: string;
		apiKey: string;
	}) => Promise<{ ok: boolean; status?: number; latencyMs?: number; message?: string }>;
};

export type ProviderReply = { ok: true; result?: unknown } | { ok: false; error: { code: string; message: string } };

/** 返回 null = 不是 provider 相关请求（交回主分发） */
export async function handleProviderRequest(
	request: { type: string } & Record<string, unknown>,
	deps: ProviderHandlerDeps,
): Promise<ProviderReply | null> {
	if (request.type === "list_providers") return { ok: true, result: { providers: await deps.store.list() } };

	if (request.type === "upsert_provider") {
		const parsed = validateProviderInput((request as unknown as UpsertProviderRequest).payload);
		if (!parsed.ok) {
			const message = parsed.errors.join("；");
			deps.notify(`provider 配置有问题：${message}`, "error");
			return { ok: false, error: { code: "provider.invalid", message } };
		}
		const result = await deps.store.upsert(parsed.value);
		if (!result.ok) {
			deps.notify(`provider 保存失败：${result.error}`, "error");
			return { ok: false, error: { code: "provider.upsert_failed", message: result.error } };
		}
		deps.logInfo("provider 已保存", {
			provider: result.view.provider,
			hasKey: result.view.hasKey,
			models: result.view.models.length,
		});
		deps.notify(
			`provider「${result.view.provider}」已保存：${result.view.models.length} 个模型${result.view.hasKey ? `，key ${result.view.keyHint}` : ""}（重启后新模型才会出现在选择器里）`,
			"info",
		);
		return { ok: true, result: { provider: result.view } };
	}

	if (request.type === "delete_provider") {
		const provider = String((request as { provider?: unknown }).provider ?? "");
		const result = await deps.store.remove(provider);
		if (!result.ok) {
			deps.notify(`删除失败：${result.error}`, "error");
			return { ok: false, error: { code: "provider.delete_failed", message: result.error } };
		}
		deps.logInfo("provider 已删除", { provider, removed: result.removed });
		deps.notify(
			result.removed ? `provider「${provider}」已删除` : `没有这个 provider：${provider}`,
			result.removed ? "info" : "warn",
		);
		return { ok: true, result: { removed: result.removed } };
	}

	if (request.type === "test_provider") {
		const provider = String((request as { provider?: unknown }).provider ?? "");
		const view = await deps.store.get(provider);
		if (!view) {
			deps.notify(`没有这个 provider：${provider}`, "warn");
			return { ok: false, error: { code: "provider.not_found", message: "没有这个 provider" } };
		}
		const apiKey = await deps.readKey(provider);
		if (!apiKey) {
			deps.notify(`provider「${provider}」还没有 api key，无法测试`, "warn");
			return { ok: false, error: { code: "provider.no_key", message: "没有 api key" } };
		}
		const result = await deps.probe({ baseUrl: view.baseUrl, apiKey });
		deps.notify(
			result.ok
				? `provider「${provider}」连通正常（HTTP ${result.status}，${result.latencyMs}ms）`
				: `provider「${provider}」连不通：${result.message}`,
			result.ok ? "info" : "error",
		);
		return { ok: true, result };
	}

	return null;
}

/** 组装依赖：把「读 key / 发探测 / 日志 / 提示」这些副作用集中在一处，index 里只留一行 */
export function createProviderDeps(options: {
	store: ProviderStore;
	notify: (text: string, level: "info" | "warn" | "error") => void;
	logger: { info: (message: string, meta?: Record<string, unknown>) => void };
	probe: ProviderHandlerDeps["probe"];
}): ProviderHandlerDeps {
	return {
		store: options.store,
		notify: options.notify,
		logInfo: (message, meta) => options.logger.info(message, meta),
		readKey: (provider) => options.store.readKey(provider),
		probe: options.probe,
	};
}

/**
 * 把「处理 → 刷新快照 → 回包」串起来（index.ts 里只留一行，见 400 行护栏）。
 * 回包用回调传入，这样这里不需要认识 WebSocket。
 */
export function createProviderRunner(options: {
	store: ProviderStore;
	notify: (text: string, level: "info" | "warn" | "error") => void;
	logger: { info: (message: string, meta?: Record<string, unknown>) => void };
	probe: ProviderHandlerDeps["probe"];
	/** 变更后把最新列表塞回 state 并推快照（前端只认快照，ADR-0004） */
	refresh: () => Promise<void>;
}): (request: { type: string } & Record<string, unknown>, reply: (result: ProviderReply) => void) => Promise<void> {
	const deps = createProviderDeps(options);
	return async (request, reply) => {
		const handled = await handleProviderRequest(request, deps);
		await options.refresh();
		if (handled) reply(handled);
	};
}
