/**
 * 「这个模型有没有被启用」——前端的唯一判定点。
 *
 * 语义必须与 `server/providers/enabled-models.ts` 的 `isModelEnabled` 完全一致，
 * 否则界面会出现「面板里关掉了、对话里还能选」这种自相矛盾：
 *   白名单为空        → 全开（pi 的语义：不限制）
 *   `provider/**`     → 这个 provider 下全开
 *   `provider/model`  → 只开这一个
 */
export function isModelEnabled(allowlist: string[], provider: string, modelId: string): boolean {
	if (allowlist.length === 0) return true;
	const full = `${provider}/${modelId}`;
	return allowlist.some((pattern) => pattern === `${provider}/**` || pattern === full);
}

/** 从 `provider/model` 形状的 id 里切出 provider（没有斜杠返回空串） */
function providerOfModelId(modelId: string): string {
	const slash = modelId.indexOf("/");
	return slash > 0 ? modelId.slice(0, slash) : "";
}

/** 便利版：直接吃 `provider/model` 形状的 id */
export function isModelIdEnabled(allowlist: string[], modelId: string): boolean {
	const provider = providerOfModelId(modelId);
	if (provider === "") return true; // 形状不认识就不拦（宁可多显示，也不要凭空消失）
	return isModelEnabled(allowlist, provider, modelId.slice(provider.length + 1));
}
