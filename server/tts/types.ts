export interface TtsVoice {
	id: string;
	name: string;
	lang: string;
	gender?: string;
}

export interface TtsVoiceList {
	voices: TtsVoice[];
	note?: string;
}

export interface TtsInput {
	text: string;
	voice: string;
	rate: number;
}

/** Adapters must reject on abort. A local worker may stay busy until the running job finishes. */
export interface TtsEngine {
	id?: string;
	/** 面板上显示的名字（没有就退回 id） */
	label?: string;
	/** 云端引擎没配密钥时是 false：前端据此提示「去哪儿填 key」 */
	configured?: boolean;
	/** 给用户看的说明（缺密钥怎么配、有什么限制） */
	note?: string;
	defaultVoice?: string;
	contentType?: "audio/mpeg" | "audio/wav";
	timeoutMs?: number;
	voices(): TtsVoiceList;
	speak(input: TtsInput, signal: AbortSignal): Promise<Buffer>;
}

export interface TtsAudio {
	audio: Buffer;
	contentType: NonNullable<TtsEngine["contentType"]>;
}

export class TtsError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
