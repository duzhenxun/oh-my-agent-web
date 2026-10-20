const PW = process.env.PW;
const headers = (client) => ({ authorization: "Basic " + Buffer.from("x:" + PW).toString("base64"), cookie: `agent-web-client=${client}` });
async function openSse(client, sink) {
	const res = await fetch("http://127.0.0.1:25257/api/events", { headers: headers(client) });
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	(async () => {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			for (const line of dec.decode(value).split("\n")) {
				if (!line.startsWith("data: ")) continue;
				const msg = JSON.parse(line.slice(6));
				if (msg.event === "snapshot") sink(msg.snapshot.active.conversationId);
			}
		}
	})();
}
const convs = await (await fetch("http://127.0.0.1:25257/api/rpc", {
	method: "POST", headers: { ...headers("tabA"), "content-type": "application/json" },
	body: JSON.stringify({ id: "r0", type: "get_state" }),
})).json().catch(() => ({}));
const state = await (await fetch("http://127.0.0.1:25257/api/events", { headers: headers("tabA") })).text().catch(() => "");
let aLatest = null, bLatest = null;
await openSse("tabA", (id) => { aLatest = id; });
await openSse("tabB", (id) => { bLatest = id; });
await new Promise((r) => setTimeout(r, 1500));
console.log("初始  A:", aLatest, " B:", bLatest);
// 用 A 的身份切会话
const others = JSON.parse((state.match(/data: (\{.*\})/) ?? [])[1] ?? "{}")?.snapshot?.conversations?.map((c) => c.id) ?? [];
const target = others.find((id) => id !== aLatest) ?? others[0];
if (target) {
	await fetch("http://127.0.0.1:25257/api/rpc", {
		method: "POST", headers: { ...headers("tabA"), "content-type": "application/json" },
		body: JSON.stringify({ id: "r1", type: "switch_conversation", payload: { conversationId: target } }),
	});
	await new Promise((r) => setTimeout(r, 2000));
	console.log("A 切换后 A:", aLatest, " B:", bLatest);
	console.log("A 切到的是:", target);
	console.log("B 未被动跟随:", bLatest !== target);
}
process.exit(0);
