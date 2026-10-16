import { readFileSync, writeFileSync } from "node:fs";

const must = (cond, label) => {
	if (!cond) throw new Error(`miss: ${label}`);
};

// ---------- 协议：附件引用 + send_message 带附件 ----------
{
	const path = "server/protocol.ts";
	let s = readFileSync(path, "utf8");
	must(s.includes("/** 可选模型（ADR-0020 §P2）"), "protocol 锚点");
	s = s.replace(
		"/** 可选模型（ADR-0020 §P2）",
		`/**
 * 附件引用（ADR-0020 §P3）：**只带引用，不带内容** —— 图片走 HTTP 上传（ADR-0004 的单条 ≤64KB），
 * 消息里只有 id。服务端据此读回文件（图片交给模型做视觉注入，其它只给路径引用）。
 */
export type AttachmentRef = {
	id: string;
	kind: "image" | "file";
	name: string;
	mime: string;
	bytes: number;
};

/** 可选模型（ADR-0020 §P2）`,
	);
	must(
		s.includes('export type SendMessageRequest = { id: string; type: "send_message"; payload: { text: string } };'),
		"SendMessageRequest",
	);
	s = s.replace(
		'export type SendMessageRequest = { id: string; type: "send_message"; payload: { text: string } };',
		'export type SendMessageRequest = {\n\tid: string;\n\ttype: "send_message";\n\tpayload: { text: string; attachments?: AttachmentRef[] };\n};',
	);
	must(s.includes('if (type === "send_message") {'), "send_message 分支");
	s = s.replace(
		`	if (type === "send_message") {
		return nonEmptyString(payload.text) ? { id, type: "send_message", payload: { text: payload.text } } : null;
	}`,
		`	if (type === "send_message") {
		// 附件只校验形状（id/kind/name/mime/bytes）：真正的文件校验在服务端读回时做
		const attachments = Array.isArray(payload.attachments)
			? payload.attachments.filter(isAttachmentRef).slice(0, 5)
			: undefined;
		if (!nonEmptyString(payload.text) && !attachments?.length) return null;
		return { id, type: "send_message", payload: { text: String(payload.text ?? ""), ...(attachments?.length ? { attachments } : {}) } };
	}`,
	);
	must(s.includes("function isRecord(value: unknown): value is Record<string, unknown> {"), "isRecord");
	s = s.replace(
		"function isRecord(value: unknown): value is Record<string, unknown> {",
		`function isAttachmentRef(value: unknown): value is AttachmentRef {
	if (!isRecord(value)) return false;
	const { id, kind, name, mime, bytes } = value;
	return (
		nonEmptyString(id) &&
		(kind === "image" || kind === "file") &&
		typeof name === "string" &&
		typeof mime === "string" &&
		typeof bytes === "number"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {`,
	);
	writeFileSync(path, s);
	console.log("协议已加附件引用");
}

// ---------- 端口：sendMessage 支持图片 ----------
{
	const path = "server/engine/port.ts";
	let s = readFileSync(path, "utf8");
	must(
		s.includes("	sendMessage(sessionId: string, text: string, onEvent: (event: EngineEvent) => void): Promise<void>;"),
		"port sendMessage",
	);
	s = s.replace(
		"	sendMessage(sessionId: string, text: string, onEvent: (event: EngineEvent) => void): Promise<void>;",
		"	sendMessage(\n\t\tsessionId: string,\n\t\ttext: string,\n\t\tonEvent: (event: EngineEvent) => void,\n\t\t/** 图片附件（ADR-0020 §P3）：base64 + mime，交给模型做视觉注入 */\n\t\toptions?: { images?: Array<{ data: string; mimeType: string }> },\n\t): Promise<void>;",
	);
	writeFileSync(path, s);
	console.log("端口已支持图片");
}

// ---------- pi-sdk：图片交给 session.prompt ----------
{
	const path = "server/engine/pi-sdk.ts";
	let s = readFileSync(path, "utf8");
	must(
		s.includes("		async sendMessage(sessionId: string, text: string, onEvent: (event: EngineEvent) => void) {"),
		"pi-sdk sendMessage",
	);
	s = s.replace(
		"		async sendMessage(sessionId: string, text: string, onEvent: (event: EngineEvent) => void) {",
		"		async sendMessage(\n\t\t\tsessionId: string,\n\t\t\ttext: string,\n\t\t\tonEvent: (event: EngineEvent) => void,\n\t\t\tmessageOptions?: { images?: Array<{ data: string; mimeType: string }> },\n\t\t) {",
	);
	must(s.includes("				await handle.session.prompt(text);"), "prompt 调用");
	s = s.replace(
		"				await handle.session.prompt(text);",
		`				// 图片走 SDK 的 images 参数（视觉注入）；没有图片时不传，避免空数组影响提示词缓存
				const images = messageOptions?.images?.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
				if (images && images.length > 0) {
					await (handle.session as unknown as { prompt: (text: string, options: { images: unknown[] }) => Promise<void> }).prompt(
						text,
						{ images },
					);
				} else {
					await handle.session.prompt(text);
				}`,
	);
	writeFileSync(path, s);
	console.log("pi-sdk 已支持图片");
}

// ---------- 假引擎：记下收到的图片（测试断言用） ----------
{
	const path = "server/engine/fake.ts";
	let s = readFileSync(path, "utf8");
	must(s.includes("		async sendMessage(sessionId: string, text: string, onEvent) {"), "fake sendMessage");
	s = s.replace(
		"		async sendMessage(sessionId: string, text: string, onEvent) {",
		"		async sendMessage(sessionId: string, text: string, onEvent, messageOptions) {\n\t\t\tif (messageOptions?.images?.length) receivedImages.push(...messageOptions.images);",
	);
	must(s.includes("	const models = new Map<string, string>();"), "fake models map");
	s = s.replace(
		"	const models = new Map<string, string>();",
		"	const models = new Map<string, string>();\n\t/** 测试钩子：宿主交给引擎的图片（ADR-0020 §P3） */\n\tconst receivedImages: Array<{ data: string; mimeType: string }> = [];",
	);
	must(s.includes("		/** 测试钩子：会话表（含 createSession 收到的历史与累积转录） */"), "fake 钩子");
	s = s.replace(
		"		/** 测试钩子：会话表（含 createSession 收到的历史与累积转录） */",
		"		/** 测试钩子：宿主交给引擎的图片 */\n\t\timages() {\n\t\t\treturn receivedImages;\n\t\t},\n\n\t\t/** 测试钩子：会话表（含 createSession 收到的历史与累积转录） */",
	);
	must(s.includes("	sessions(): Map<"), "FakeEngine 类型钩子");
	s = s.replace(
		"	sessions(): Map<",
		"	/** 测试钩子：宿主交给引擎的图片 */\n\timages(): Array<{ data: string; mimeType: string }>;\n\n\tsessions(): Map<",
	);
	writeFileSync(path, s);
	console.log("假引擎已支持图片");
}
