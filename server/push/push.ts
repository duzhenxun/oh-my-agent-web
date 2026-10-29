/**
 * Web Push（VAPID）：注册订阅 + 推送。
 *
 * 订阅存 `<dataDir>/push-subscriptions.json`（0600，只含 endpoint / keys，没有凭证）。
 * VAPID 密钥存 `<dataDir>/vapid-keys.json`（0600，可用环境变量覆盖）。
 *
 * **密钥以前是三个常量直接写在源码里**：那是真凭证 —— 谁拿到私钥就能冒充这个应用，
 * 往该应用所有已订阅设备推任意通知；而且它跟着 npm 包一起发出去（`files` 含 dist）。
 * 现在改成「环境变量 > 数据目录里的 0600 文件 > 首次启动生成」，仓库里不再有真密钥。
 */
import { tempPathFor } from "../util/atomic-write.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import webpush from "web-push";
import { BRAND_NAME } from "../brand.js";
import { chmodSecret } from "../util/file-mode.js";

/** VAPID subject：只是给推送网关留个联系方式，不是凭证 */
const DEFAULT_VAPID_SUBJECT = "mailto:noreply@localhost";

type VapidKeys = { publicKey: string; privateKey: string; subject: string };

/**
 * 取 VAPID 密钥：环境变量 > `<dataDir>/vapid-keys.json` > 首次生成并落盘。
 *
 * 只读一次就够（进程内缓存在 createPushStore）。
 */
async function loadVapidKeys(dataDir: string): Promise<VapidKeys> {
	const envPublic = process.env.VAPID_PUBLIC_KEY ?? "";
	const envPrivate = process.env.VAPID_PRIVATE_KEY ?? "";
	const subject = process.env.VAPID_SUBJECT ?? DEFAULT_VAPID_SUBJECT;
	if (envPublic !== "" && envPrivate !== "") return { publicKey: envPublic, privateKey: envPrivate, subject };

	const path = join(dataDir, "vapid-keys.json");
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<VapidKeys>;
		if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
			return {
				publicKey: parsed.publicKey,
				privateKey: parsed.privateKey,
				subject: typeof parsed.subject === "string" && parsed.subject !== "" ? parsed.subject : subject,
			};
		}
	} catch {
		// 没有 / 坏了 → 下面生成一份（旧的订阅会失效，客户端重新订阅即可）
	}

	const generated = webpush.generateVAPIDKeys();
	const keys: VapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey, subject };
	await mkdir(dataDir, { recursive: true });
	const temporary = tempPathFor(path);
	await writeFile(temporary, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmodSecret(path);
	return keys;
}

type PushSubscriptionView = {
	endpoint: string;
	keys?: { p256dh: string; auth: string };
	/** 哪个客户端订阅的（同一浏览器多标签会重复订阅，用 endpoint 去重即可） */
	clientId?: string;
	createdAt: number;
	/** 设备别名（界面上可改） */
	name?: string;
	/**
	 * 这台设备上「顶栏自称」的名字（设置 → 外观 改名，默认 = `BRAND_NAME`）。
	 *
	 * 为什么存在订阅上：名字是本机偏好（localStorage），服务端本来看不到；
	 * 而推送标题是服务端拼的。订阅是**每设备一条**，正好就是它的归属。
	 * 没存 = 老订阅没报过名，按产品默认名拼。
	 */
	brandName?: string;
	/** 上次推送时间与结果，界面上展示 */
	lastSentAt?: number;
	lastStatus?: string;
};

type PushPayload = { title: string; body: string; url?: string; tag?: string };

/**
 * 一次推送的文案：要么全体一样，要么**按订阅算**。
 *
 * 按订阅算是因为标题里有「这台设备自己起的名字」：两台设备各改了不同的名，
 * 同一个标题就不可能是对的。正文类文案（会话名）仍然是全体一样的。
 */
type PushPayloadSource = PushPayload | ((subscription: PushSubscriptionView) => PushPayload);

export type PushStore = {
	/** 前端订阅要用的公钥（以前是个模块级常量，现在得等密钥就绪） */
	publicKey: () => Promise<string>;
	list: () => Promise<PushSubscriptionView[]>;
	add: (subscription: PushSubscriptionView) => Promise<{ ok: true; total: number }>;
	remove: (endpoint: string) => Promise<{ ok: true; total: number }>;
	send: (payload: PushPayloadSource, endpoints?: string[]) => Promise<{ sent: number; failed: number }>;
	rename: (endpoint: string, name: string) => Promise<{ ok: true; total: number }>;
	/** 改这台设备的界面自称（空串 = 改回产品默认名） */
	setBrandName: (endpoint: string, brandName: string) => Promise<{ ok: true; total: number }>;
	removeOne: (endpoint: string) => Promise<{ ok: true; total: number }>;
	clear: () => Promise<{ ok: true; total: 0 }>;
	count: () => Promise<number>;
};

export function createPushStore(options: { dataDir: string; now: () => number }): PushStore {
	const path = join(options.dataDir, "push-subscriptions.json");
	/**
	 * 密钥懒解析 + 只算一次。
	 * 失败不缓存（清回 null），下次请求会重试 —— 否则一次磁盘满就把推送永久钉死。
	 */
	let keysPromise: Promise<VapidKeys> | null = null;
	const keys = (): Promise<VapidKeys> => {
		if (!keysPromise) {
			const pending = loadVapidKeys(options.dataDir).then((resolved) => {
				webpush.setVapidDetails(resolved.subject, resolved.publicKey, resolved.privateKey);
				return resolved;
			});
			keysPromise = pending;
			pending.catch(() => {
				if (keysPromise === pending) keysPromise = null;
			});
		}
		return keysPromise;
	};

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
		const temporary = tempPathFor(path);
		await writeFile(temporary, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, path);
		await chmodSecret(path);
	};

	return {
		publicKey: async () => (await keys()).publicKey,
		list: read,
		async add(subscription) {
			const list = await read();
			// endpoint 相同视为同一订阅：更新，但**保留用户改过的名字**
			// （设备别名与界面自称都是用户改过的，重订阅不能把它们冲回默认；
			//  自称还要区分「没传」与「传了空串 = 改回默认名」：前者保留，后者清掉）
			const previous = list.find((item) => item.endpoint === subscription.endpoint);
			const merged = {
				...subscription,
				...(previous?.name ? { name: previous.name } : {}),
				...(subscription.brandName === undefined && previous?.brandName ? { brandName: previous.brandName } : {}),
			};
			if (merged.brandName === "") delete merged.brandName;
			const next = [...list.filter((item) => item.endpoint !== subscription.endpoint), merged];
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
		async rename(endpoint, name) {
			const list = await read();
			await write(list.map((item) => (item.endpoint === endpoint ? { ...item, name } : item)));
			return { ok: true, total: (await read()).length };
		},
		async setBrandName(endpoint, brandName) {
			const list = await read();
			// 空串 = 改回产品默认名：把字段删掉，而不是存一个 ""（老代码读不到也能回落）
			const next = list.map((item) => {
				if (item.endpoint !== endpoint) return item;
				const { brandName: _previous, ...rest } = item;
				return brandName === "" ? rest : { ...item, brandName };
			});
			await write(next);
			return { ok: true, total: next.length };
		},
		async removeOne(endpoint) {
			const next = (await read()).filter((item) => item.endpoint !== endpoint);
			await write(next);
			return { ok: true, total: next.length };
		},
		async clear() {
			await write([]);
			return { ok: true, total: 0 };
		},
		async send(payload, endpoints) {
			// 先把密钥准备好：setVapidDetails 没调过就发，web-push 会直接抛「没配 VAPID」
			await keys();
			const all = await read();
			const list = endpoints ? all.filter((item) => endpoints.includes(item.endpoint)) : all;
			let sent = 0;
			let failed = 0;
			const dead: string[] = [];
			const status = new Map<string, string>();
			for (const subscription of list) {
				// 标题可能依赖这台设备自己的名字（见 PushPayloadSource），所以文案在循环里才定下来
				const message = typeof payload === "function" ? payload(subscription) : payload;
				try {
					await webpush.sendNotification(
						{ endpoint: subscription.endpoint, keys: subscription.keys } as never,
						JSON.stringify(message),
					);
					sent += 1;
					status.set(subscription.endpoint, "成功");
				} catch (error) {
					failed += 1;
					const code = (error as { statusCode?: number }).statusCode;
					// 404/410：订阅已失效，顺手清掉，避免每次白打
					if (code === 404 || code === 410) dead.push(subscription.endpoint);
					status.set(subscription.endpoint, `失败 ${code ?? ""}`.trim());
				}
			}
			// 记下「上次推送」：界面要显示时间与结果
			const stamped = all
				.filter((item) => !dead.includes(item.endpoint))
				.map((item) =>
					status.has(item.endpoint)
						? { ...item, lastSentAt: options.now(), lastStatus: status.get(item.endpoint) }
						: item,
				);
			if (stamped.length !== all.length || status.size > 0) await write(stamped);
			return { sent, failed };
		},
	};
}

/**
 * 推送标题里的「应用自称」：这台设备改过名就用它的，否则用产品默认名。
 *
 * 为什么要看订阅而不是一个全局值：名字是本机偏好（设置 → 外观），
 * 两台设备可以叫不同的名字 —— 只有订阅上那一份能对上「这行字要出现在谁的锁屏上」。
 */
export function brandNameOf(subscription: PushSubscriptionView | undefined): string {
	const name = subscription?.brandName?.trim() ?? "";
	return name === "" ? BRAND_NAME : name;
}

/** 项目名 = 工作区路径的最后一段（拿不到就回落应用自称，别把通知的抬头留空） */
export function projectNameOf(workspace: string | undefined, fallback: string = BRAND_NAME): string {
	const name = basename(workspace ?? "");
	return name && name !== "" ? name : fallback;
}

/**
 * 回合结束时的那条通知（index 里只留一行调用）。
 *
 * 排版按手机锁屏来定：**第一行（title）= 项目名，正文（body）= 会话名**。
 * 锁屏只露两行，「哪个项目的哪个会话」一眼能认；「回合完成」这种套话不占位置
 * （通知本身出现就代表完成了）。点开仍直达那条会话（url 带 ?session=）。
 */
export function notifyTurnFinished(
	store: PushStore,
	info: {
		conversationId: string;
		title: string;
		workspace?: string;
		/** 这一轮是否以错误收尾（true = 锁屏上标 ❌） */
		failed?: boolean;
		/** 是否被用户停掉（true = 锁屏上标 ⏹） */
		interrupted?: boolean;
	},
): void {
	// 正常完成**不加任何套话**（见上面的排版约定）；只有「不是正常完成」才给个语言中立的
	// 前缀 —— 否则锁屏上「出错了」和「完成了」长得一模一样，反而害人不看。
	const mark = info.failed === true ? "❌ " : info.interrupted === true ? "⏹ " : "";
	// 标题仍以项目名为主（锁屏上「哪个项目的哪个会话」最有信息量）；
	// 只有拿不到项目名时才用**这台设备自己起的名字**兜底
	void store.send((subscription) => ({
		title: projectNameOf(info.workspace, brandNameOf(subscription)),
		body: `${mark}${info.title.trim() || "会话"}`,
		url: `/?session=${encodeURIComponent(info.conversationId)}`,
		tag: `turn-${info.conversationId}`,
	}));
}
