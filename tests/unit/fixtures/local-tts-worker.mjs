import { createInterface } from "node:readline";

let requests = 0;
const defaults = { kokoro: "zf_xiaoxiao", qwen3: "serena" };

function wav(sample) {
	const audio = Buffer.alloc(46);
	audio.write("RIFF");
	audio.writeUInt32LE(38, 4);
	audio.write("WAVEfmt ", 8);
	audio.writeUInt32LE(16, 16);
	audio.writeUInt16LE(1, 20);
	audio.writeUInt16LE(1, 22);
	audio.writeUInt32LE(24_000, 24);
	audio.writeUInt32LE(48_000, 28);
	audio.writeUInt16LE(2, 32);
	audio.writeUInt16LE(16, 34);
	audio.write("data", 36);
	audio.writeUInt32LE(2, 40);
	audio.writeInt16LE(sample, 44);
	return audio;
}

createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, engine, text, voice, rate } = JSON.parse(line);
	const count = ++requests;
	const send = (reply) => process.stdout.write(`${JSON.stringify({ id, ...reply })}\r\n`);
	if (text === "exit") process.exit(1);
	if (text === "hang") return;
	if (text === "malformed") return process.stdout.write("corrupt protocol\n");
	if (text === "bad-wav") return send({ audio: Buffer.from("not WAV").toString("base64") });
	if (text === "unknown-error") return send({ error: "private worker diagnostics" });
	if (
		!Object.hasOwn(defaults, engine) ||
		(text === "defaults" && (voice !== defaults[engine] || rate !== 1)) ||
		(text === "custom" && (engine !== "qwen3" || voice !== "vivian" || rate !== 1.5))
	) {
		return send({ error: "invalid_request" });
	}
	process.stderr.write("private worker diagnostics\n");
	process.stdout.write(`${JSON.stringify({ id: id + 1000, error: "synthesis_failed" })}\n`);
	const reply = JSON.stringify({ id, audio: wav(count).toString("base64") });
	const respond = () => {
		process.stdout.write(reply.slice(0, 10));
		setImmediate(() => process.stdout.write(`${reply.slice(10)}\r\n`));
	};
	if (text === "slow") setTimeout(respond, 200);
	else respond();
});
