/** 统一 provider 请求头：协议决定鉴权头，自定义 headers 最后覆盖同名项。 */
export function providerHeaders(
	api: string,
	apiKey: string,
	custom: Record<string, string> = {},
): Record<string, string> {
	const headers: Record<string, string> =
		api === "anthropic-messages"
			? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
			: { authorization: `Bearer ${apiKey}` };
	return { ...headers, ...custom };
}
