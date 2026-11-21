/**
 * Plain CommonJS worker source runs in both tsx development and compiled builds.
 * Only structured data crosses the boundary; upstream errors/text never reach logs.
 * A worker is necessary because the library cannot abort a pending handshake/read.
 */
export const EDGE_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { EdgeTTS } = require(workerData.modulePath);
(async () => {
  try {
    const { text, voice, lang, rate, timeoutMs, maxAudioBytes } = workerData;
    const engine = new EdgeTTS({
      voice, lang, rate,
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      timeout: timeoutMs,
    });
    const chunks = [];
    let size = 0;
    for await (const chunk of engine.streamAudio(text)) {
      if (!Buffer.isBuffer(chunk)) continue;
      size += chunk.length;
      if (size > maxAudioBytes) {
        parentPort.postMessage({ error: "limit" });
        return;
      }
      chunks.push(chunk);
    }
    if (size === 0) {
      parentPort.postMessage({ error: "upstream" });
      return;
    }
    const audio = Uint8Array.from(Buffer.concat(chunks, size));
    parentPort.postMessage({ audio }, [audio.buffer]);
  } catch {
    parentPort.postMessage({ error: "upstream" });
  }
})();
`;
