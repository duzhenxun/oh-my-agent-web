import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { LOCAL_VOICES, localVoices, type LocalEngineId } from "./local-voices.js";
import { TtsError, type TtsEngine, type TtsInput } from "./types.js";

const TIMEOUT_MS = { kokoro: 120_000, qwen3: 300_000 };
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_REPLY_BYTES = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 128;

function workerScript(): string {
	const adjacent = fileURLToPath(new URL("./local-worker.py", import.meta.url));
	// tsc emits the JS under dist/server/tts and leaves the Python file in the checkout.
	return existsSync(adjacent)
		? adjacent
		: fileURLToPath(new URL("../../../server/tts/local-worker.py", import.meta.url));
}

function unavailable(): TtsError {
	return new TtsError(502, "本地 TTS 合成失败");
}

function decodeWav(encoded: unknown): Buffer | undefined {
	if (typeof encoded !== "string" || encoded.length % 4 !== 0 || encoded.length > MAX_REPLY_BYTES) return;
	const wav = Buffer.from(encoded, "base64");
	if (
		wav.length <= 44 ||
		wav.length > MAX_AUDIO_BYTES ||
		wav.toString("base64") !== encoded ||
		wav.toString("ascii", 0, 4) !== "RIFF" ||
		wav.readUInt32LE(4) !== wav.length - 8 ||
		wav.toString("ascii", 8, 16) !== "WAVEfmt " ||
		wav.readUInt32LE(16) !== 16 ||
		wav.readUInt16LE(20) !== 1 ||
		wav.readUInt16LE(22) !== 1 ||
		wav.readUInt32LE(24) !== 24_000 ||
		wav.readUInt32LE(28) !== 48_000 ||
		wav.readUInt16LE(32) !== 2 ||
		wav.readUInt16LE(34) !== 16 ||
		wav.toString("ascii", 36, 40) !== "data" ||
		wav.readUInt32LE(40) !== wav.length - 44 ||
		wav.length % 2 !== 0
	)
		return;
	return wav;
}

type Result = TtsError | Buffer;
interface Job {
	id: number;
	timer: NodeJS.Timeout;
	reply?: (result: Result) => void;
}
interface LocalWorker {
	child: ChildProcessWithoutNullStreams;
	lines: ReturnType<typeof createInterface>;
	job?: Job;
	stopping: boolean;
}

/** Both providers share one process and one model slot. There is no request queue. */
export function createLocalEngines(timeoutMs?: number) {
	let worker: LocalWorker | undefined;
	let nextId = 0;
	let closed = false;

	function finish(current: LocalWorker, result: Result): void {
		const job = current.job;
		if (!job) return;
		current.job = undefined;
		clearTimeout(job.timer);
		job.reply?.(result);
	}

	function stop(current: LocalWorker, reason: TtsError): void {
		if (current.stopping) return;
		current.stopping = true;
		finish(current, reason);
		current.lines.close();
		current.child.stdin.destroy();
		// Release the model even if MLX is blocked. Wait for close before starting a replacement.
		current.child.kill("SIGKILL");
	}

	function start(): LocalWorker {
		const python = process.env.OH_MY_AGENT_TTS_PYTHON || join(homedir(), "tts", ".venv", "bin", "python");
		const script = process.env.OH_MY_AGENT_TTS_SCRIPT || workerScript();
		const child = spawn(python, [script], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		});
		child.stderr.resume();
		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
		const current: LocalWorker = { child, lines, stopping: false };
		const fail = () => stop(current, unavailable());
		let lineBytes = 0;
		// Bound a broken worker's output before readline buffers a whole unterminated line.
		child.stdout.prependListener("data", (chunk: Buffer) => {
			let start = 0;
			for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
				if (lineBytes + end - start > MAX_REPLY_BYTES) return fail();
				lineBytes = 0;
				start = end + 1;
			}
			lineBytes += chunk.length - start;
			if (lineBytes > MAX_REPLY_BYTES) fail();
		});
		lines.on("line", (line) => {
			if (current.stopping) return;
			let response: { id?: unknown; audio?: unknown; error?: unknown };
			try {
				response = JSON.parse(line);
			} catch {
				return fail();
			}
			if (!response || !Number.isSafeInteger(response.id)) return fail();
			const job = current.job;
			if (!job || job.id !== response.id) return;
			if (response.error === "invalid_request") finish(current, new TtsError(400, "本地 TTS 请求无效"));
			else if (response.error === "audio_limit") finish(current, new TtsError(502, "本地 TTS 音频超过大小限制"));
			else if (response.error === "synthesis_failed") finish(current, unavailable());
			else if (response.error !== undefined) fail();
			else if (!job.reply)
				finish(current, unavailable()); // Discard canceled audio without decoding it.
			else {
				const audio = decodeWav(response.audio);
				if (audio) finish(current, audio);
				else fail();
			}
		});
		lines.on("error", fail);
		lines.on("close", fail);
		child.stdin.on("error", fail);
		child.on("error", fail);
		child.once("close", () => {
			finish(current, unavailable());
			if (worker === current) worker = undefined;
		});
		return current;
	}

	async function speak(engine: LocalEngineId, input: TtsInput, signal: AbortSignal): Promise<Buffer> {
		signal.throwIfAborted();
		if (closed) throw unavailable();
		if (worker?.job || worker?.stopping) throw new TtsError(429, "本地 TTS 正忙，请稍后重试");
		const current = worker ?? (worker = start());
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			const abort = () => {
				const reason = signal.reason ?? new TtsError(499, "TTS 请求已取消");
				if (reason instanceof TtsError && reason.status === 504) stop(current, reason);
				else {
					job.reply = undefined;
					signal.removeEventListener("abort", abort);
					reject(reason);
				}
			};
			const timer = setTimeout(
				() => stop(current, new TtsError(504, "本地 TTS 合成超时")),
				timeoutMs ?? TIMEOUT_MS[engine],
			);
			const job: Job = {
				id,
				timer,
				reply(result) {
					signal.removeEventListener("abort", abort);
					if (Buffer.isBuffer(result)) resolve(result);
					else reject(result);
				},
			};
			current.job = job;
			signal.addEventListener("abort", abort, { once: true });
			current.child.stdin.write(JSON.stringify({ id, engine, ...input }) + "\n", (error) => {
				if (error) stop(current, unavailable());
			});
		});
	}

	const engines = (Object.keys(LOCAL_VOICES) as LocalEngineId[]).map(
		(id) =>
			({
				id,
				defaultVoice: LOCAL_VOICES[id].defaultVoice,
				contentType: "audio/wav",
				timeoutMs: TIMEOUT_MS[id],
				voices: () => localVoices(id),
				speak: (input, signal) => speak(id, input, signal),
			}) satisfies TtsEngine,
	);
	return {
		engines,
		close() {
			closed = true;
			if (worker) stop(worker, unavailable());
		},
	};
}
