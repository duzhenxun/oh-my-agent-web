/**
 * Web Push（VAPID）：注册订阅 + 推送。
 *
 * 订阅存 `<dataDir>/push-subscriptions.json`（0600，只含 endpoint / keys，没有凭证）。
 * VAPID 密钥默认内置（可用环境变量覆盖），私钥只在服务端。
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import webpush from "web-push";

export const VAPID_PUBLIC_KEY =
	process.env.VAPID_PUBLIC_KEY ??
	"BPnvp8p4QdnOh4vO6-oAhxFGouHJTqY68C_4-goxBh1sphBEb1blz2FgqyEVg5JoFMBdSJKu2tDR-VLkdUNIHrQ";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "UArGsIjinVV7Lk0g3zOdkMctvWIoTzUT8jV2vayiOyQ";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:duzhenxun@126.com";

export type PushSubscriptionView = {
	endpoint: string;
	keys?: { p256dh: string; auth: string };
	/** 哪个客户端订阅的（同一浏览器多标签会重复订阅，用 endpoint 去重即可） */
	clientId?: string;
	createdAt: number;
};

export type PushPayload = { title: string; body: string; url?: string; tag?: string };

export type PushStore = {
	list: () => Promise<PushSubscriptionView[]>;
	add: (subscription: PushSubscriptionView) => Promise<{ ok: true; total: number }>;
	remove: (endpoint: string) => Promise<{ ok: true; total: number }>;
	send: (payload: PushPayload) => Promise<{ sent: number; failed: number }>;
	count: () => Promise<number>;
};

export function createPushStore(options: { dataDir: string; now: () => number }): PushStore {
	const path = join(options.dataDir, "push-subscriptions.json");
	webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

	const read = async (): Promise<PushSubscriptionView[]> => {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			return Array.isArray(parsed) ? (parsed as PushSubscriptionView[]) : [];
		} catch {
			return [];
		}
	};

	const write = async (list: PushSubscriptionView[]): Promise<void> => {
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(temporary, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, path);
		await chmod(path, 0o600);
	};

	return {
		list: read,
		async add(subscription) {
			const list = await read();
			// endpoint 相同视为同一订阅：更新而不是重复追加
			const next = [...list.filter((item) => item.endpoint !== subscription.endpoint), subscription];
			await write(next);
			return { ok: true, total: next.length };
		},
		async remove(endpoint) {
			const next = (await read()).filter((item) => item.endpoint !== endpoint);
			await write(next);
			return { ok: true, total: next.length };
		},
		async count() {
			return (await read()).length;
		},
		async send(payload) {
			const list = await read();
			let sent = 0;
			let failed = 0;
			const dead: string[] = [];
			for (const subscription of list) {
				try {
					await webpush.sendNotification(
						{ endpoint: subscription.endpoint, keys: subscription.keys } as never,
						JSON.stringify(payload),
					);
					sent += 1;
				} catch (error) {
					failed += 1;
					const status = (error as { statusCode?: number }).statusCode;
					// 404/410：订阅已失效，顺手清掉，避免每次白打
					if (status === 404 || status === 410) dead.push(subscription.endpoint);
				}
			}
			if (dead.length > 0) await write(list.filter((item) => !dead.includes(item.endpoint)));
			return { sent, failed };
		},
	};
}

/** 回合结束时的那条通知（index 里只留一行调用） */
export function notifyTurnFinished(store: PushStore, info: { conversationId: string; title: string }): void {
	void store.send({
		title: "Agent Web · 回合完成",
		body: `${info.title} 已回复，点开查看`,
		url: `/?session=${encodeURIComponent(info.conversationId)}`,
		tag: `turn-${info.conversationId}`,
	});
}
