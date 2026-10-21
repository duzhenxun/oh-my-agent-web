/* Service Worker：接收 push 并展示通知（也是 PWA 可安装的前提） */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let data = { title: "Agent Web", body: "有新的消息", url: "/" };
	try {
		if (event.data) data = { ...data, ...event.data.json() };
	} catch {
		if (event.data) data.body = event.data.text();
	}

	event.waitUntil(
		self.registration.showNotification(data.title, {
			body: data.body,
			icon: "/favicon.svg",
			badge: "/favicon.svg",
			// 同 tag 的通知会互相替换，避免攒一堆
			tag: data.tag || "agent-web",
			data: { url: data.url || "/" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = event.notification.data?.url || "/";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
			for (const client of list) {
				if (!("focus" in client)) continue;
				// 关键：已经开着的窗口也要**导航到通知里的地址**（带上 ?session=<id>），
				// 否则点了只是把旧页面拉到前台，停在上一个会话上。
				client.navigate(target).catch(() => {});
				return client.focus();
			}
			return self.clients.openWindow(target);
		}),
	);
});
