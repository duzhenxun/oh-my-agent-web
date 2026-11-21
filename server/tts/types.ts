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
