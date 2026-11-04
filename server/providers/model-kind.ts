/**
 * 「这个模型能不能聊天」—— 分类器 / 图像模型不能，别当成聊天模型摆给用户。
 *
 * 现象（2026-11-03 用户报）：服务商列表里多出一个 `typesafe`，标着「引擎已可用」，
 * 展开只有一个 `jev-latest`，点删除还删不掉（它不在这两份配置文件里 —— 钥匙是环境变量
 * `TYPESAFE_API_KEY` 给的）。`jev-latest` 是 pi 的**分类器**模型：只走 codemode 的
 * `models.classify()`，不能对话，也不该进「模型」面板和输入区的模型下拉。
 *
 * 根源：`ModelRuntime.getAvailable()` 报的是**所有类型**的模型（chat / image / classifier），
 * 而聊天面对外那份（`getAvailableSnapshot()`、pi 自己的 `/model`）是过滤过的。
 * 宿主这边没有分类器 / 出图入口，所以过滤掉才是对的：
 *   - `type` 明确写了非 `chat`（pi-ai 的类型判别字段；聊天模型常常不写 type）；
 *   - 或协议形态本身就不是聊天（`ClassifierApi` / `ImageApi` 那几个）。
 *
 * 纯函数、不引 SDK 类型：引擎层（`pi-sdk.ts`）与测试都只用这里。
 */
const NON_CHAT_APIS = new Set([
	// pi-ai 的 ClassifierApi：结构化分类，不能对话
	"typesafe-system-one",
	"cloudflare-workers-ai-system-one",
	"llama-cpp-classify",
	"openai-decisions",
	// pi-ai 的 ImageApi：只出图
	"openrouter-images",
]);

/** 判定只用到这两个字段（引擎报上来的模型对象是宽类型，这里只认这两样） */
export type ModelShape = { type?: string; api?: string };

/** 聊天模型：`type` 没写或写了 `chat`，且协议不是分类器 / 出图那几种 */
export function isChatModel(model: ModelShape): boolean {
	if (model.type !== undefined && model.type !== "chat") return false;
	return model.api === undefined || !NON_CHAT_APIS.has(model.api);
}

/** 只留聊天模型（保持原顺序，不改原数组） */
export function chatModels<T extends ModelShape>(models: readonly T[]): T[] {
	return models.filter(isChatModel);
}
