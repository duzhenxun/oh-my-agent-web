/**
 * Plain CommonJS worker source runs in both tsx development and compiled builds.
 * Only structured data crosses the boundary; upstream errors/text never reach logs.
 * A worker is necessary because the library cannot abort a pending handshake/read.
 *
 * 失败只回传**类别**（`rate-limited` / `timeout` / `upstream` / `limit`）：
 * 主线程要据此决定「这次值得重试吗」——限流（429/403）立刻重试只会拿到同样的回应，
 * 握手超时才是瞬时抖动。原始报错文本照旧不出这个 worker。
 */
export const EDGE_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { EdgeTTS } = require(workerData.modulePath);
function category(error) {
  const message = String((error && error.message) || error || "");
  if (/429|403/.test(message)) return "rate-limited";
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up/i.test(message)) return "timeout";
  return "upstream";
}
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
  } catch (error) {
    parentPort.postMessage({ error: category(error) });
  }
})();
`;
