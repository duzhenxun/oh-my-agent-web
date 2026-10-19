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

	return null;
}
