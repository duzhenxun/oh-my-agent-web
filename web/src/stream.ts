/**
 * 服务端 → 浏览器的推送通道：**WebSocket 为主，SSE 兜底**（ADR-0032 修订）。
 *
 * 为什么换：Chrome 对同一个 `host:port` 只有 **6 条** HTTP/1.1 连接，而 SSE 是长连接 ——
 * 每个标签页 / 每个终端 / 每个临时聊天各占一条，占满之后连**页面本身**都加载不出来
 * （DevTools 里停在 `Provisional headers are shown`，应用看着像卡死）。
 * WebSocket 不占这 6 条（每 host 上限 255），所以长连接全走它，HTTP 池留给短请求。
 *
 * 兜底：如果 Upgrade 被代理/网关挡掉（握手直接失败），这一页**自动退回 SSE**，
 * 并且之后不再重试 WS —— 老部署（nginx 没配 Upgrade、只转发普通请求）照常能用。
 *
 * 帧格式两边**一模一样**：WS 的每一条 text 消息 = SSE 里 `data:` 后面那串字节。
 * 所以调用方的解析代码一份就够（见 ws.ts / side-chat.ts / TerminalPanel.tsx）。
 */

export type StreamHandlers = {
	/** 连上了（每次重连都会再调一次：调用方在这里要一次权威快照） */
	onOpen: () => void;
	/** 一帧数据（WS text / SSE data，原样字符串） */
	onMessage: (data: string) => void;
	/** 断了，且**不会自己好**（WS 关闭 / SSE 放弃）：由调用方决定重连节奏 */
	onClose: () => void;
	/** 连接层报错（多半是登录态过期 / 后端刚重启）：调用方用它做一次探活，不必重连 */
	onError?: () => void;
};

export type Stream = { close: () => void };

/** 这一页已经证明 WS 走不通（代理挡了 Upgrade）→ 之后都用 SSE，不每次都白试一次 */
let preferSse = false;

/**
 * 开一条推送通道。
 *
 * `wsPath`：WS 的路径 + 查询串（`/ws?client=…`）；
 * `sseUrl`：同一条流的 SSE 地址（兜底用，`/api/events?client=…`）。
 */
export function openStream(input: { wsPath: string; sseUrl: string; handlers: StreamHandlers }): Stream {
	const { wsPath, sseUrl, handlers } = input;
	let disposed = false;
	let transport: { close: () => void } | null = null;

	const openSse = () => {
		const source = new EventSource(sseUrl);
		transport = source;
		source.onopen = () => handlers.onOpen();
		source.onmessage = (event) => handlers.onMessage(String(event.data));
		// SSE 会自己重连（浏览器行为）+ 调用方的退避重连：这里只报个错，不当成「断线」，
		// 否则调用方会同时再开一条，两条流叠在一起
		source.onerror = () => handlers.onError?.();
	};

	const openWs = () => {
		const protocol = window.location.protocol === "https:" ? "wss" : "ws";
		let socket: WebSocket;
		try {
			socket = new WebSocket(`${protocol}://${window.location.host}${wsPath}`);
		} catch {
			preferSse = true;
			openSse();
			return;
		}
		transport = { close: () => socket.close() };
		/** 握手成功过没有：没成功就说明 upgrade 被挡了（要退回 SSE），成功过就是普通断线（交给调用方重连） */
		let opened = false;
		socket.onopen = () => {
			opened = true;
			handlers.onOpen();
		};
		socket.onmessage = (event) => {
			// 我们只发 text 帧；二进制帧（不会有）直接忽略
			if (typeof event.data === "string") handlers.onMessage(event.data);
		};
		socket.onerror = () => handlers.onError?.();
		socket.onclose = () => {
			if (disposed) return;
			if (!opened) {
				// 握手就没成：代理 / 网关没放行 Upgrade，或鉴权没过 —— 换成 SSE 再试一次
				preferSse = true;
				openSse();
				return;
			}
			handlers.onClose();
		};
	};

	if (preferSse) openSse();
	else openWs();

	return {
		close: () => {
			disposed = true;
			transport?.close();
		},
	};
}
