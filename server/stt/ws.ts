/**
 * 千问实时语音的两套协议共用的最小 WebSocket 适配。
 *
 * 为什么单独一个文件：`qwen-realtime.ts`（ASR message 协议：run-task / result-generated）
 * 和 `qwen-omni-realtime.ts`（Realtime 协议：session.update / input_audio_buffer.append）
 * 是两套完全不同的协议，但「怎么拿到 WebSocket、怎么把 extraFields 收敛成上游要的类型」
 * 是一模一样的 —— 复制一份只会两边慢慢抄歪。
 */

/** 只用到这几个方法：避免依赖 Node 的 WebSocket 类型声明（各版本位置不一样） */
export type SocketLike = {
	send(data: string | Uint8Array): void;
	close(): void;
	addEventListener(type: string, handler: (event: { data?: unknown; message?: string }) => void): void;
};

export type SocketCtor = new (url: string, options?: { headers?: Record<string, string> }) => SocketLike;

/**
 * 拿 WebSocket 构造器。
 *
 * 刻意**每次现取** `globalThis.WebSocket`：Node 22 自带（实测我们打包的那份 node-runtime
 * 22.22 也支持构造时传 `headers`，鉴权头就能直接带上），而单测里替换掉这个全局就能
 * 不开真连接地验证协议 —— 不用为测试引依赖，也不用给生产代码加注入参数。
 */
export function socketCtor(): SocketCtor {
	const ctor = (globalThis as { WebSocket?: SocketCtor }).WebSocket;
	if (!ctor) throw new Error("当前 Node 没有内置 WebSocket（需要 Node 22+）");
	return ctor;
}

/** 把 `extraFields` 里的字符串收敛成上游要的类型（true/false → boolean，数字 → number） */
export function coerce(value: string): string | number | boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	const num = Number(value);
	return value.trim() !== "" && Number.isFinite(num) ? num : value;
}
