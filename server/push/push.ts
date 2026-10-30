/**
 * Web Push（VAPID）：注册订阅 + 推送。
 *
 * 订阅存 `<dataDir>/push-subscriptions.json`（0600，只含 endpoint / keys，没有凭证）。
 * VAPID **密钥对**存 `<dataDir>/vapid-keys.json`、**联系方式（subject）** 存
 * `<dataDir>/push-config.json`：一个换掉就作废所有订阅，一个随便改，所以分开存也分开说明。
 * 两者都可用环境变量覆盖，取用 / 校验的细节在 `vapid-config.ts`。
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
import {
	fingerprintOf,
	loadVapidKeys,
	loadVapidSubject,
	normalizeVapidSubject,
	regenerateVapidKeys,
	saveVapidSubject,
	vapidSubjectProblem,
	type VapidKeys,
	type VapidKeySource,
	type VapidSubjectSource,
} from "./vapid-config.js";

/**
 * 推给界面的「这台服务端的 VAPID 状态」（**不含私钥**）。
 *
 * 界面上「本机推送」那一段要能回答三个问题：用的是哪把钥匙（指纹）、哪来的（env / 文件）、
 * 联系方式配没配对（Apple 只收合法 subject）。没有这些，用户看到 `失败 403` 只能猜。
 */
export type PushConfigView = {
	publicKey: string;
	fingerprint: string;
	keySource: VapidKeySource;
	/** 密钥文件生成时间（来源是环境变量时为 null） */
	keyCreatedAt: number | null;
	subject: string;
	subjectSource: VapidSubjectSource;
	subjectValid: boolean;
	/** 不合法时的机器码（`push.subject.*`），界面上翻译成人话 */
	subjectProblem: string | null;
	/** 被环境变量钉死的那一项：界面上禁掉输入 / 按钮，并说明改哪 */
	locked: { keys: boolean; subject: boolean };
};

type PushConfigResult = { ok: true; config: PushConfigView } | { ok: false; code: string };

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
	/** 当前 VAPID 状态（公钥指纹 / 来源 / subject 合不合法） */
	config: () => Promise<PushConfigView>;
	/** 改联系方式（`""` = 清掉配置、回兜底）；**不影响已订阅设备** */
	saveSubject: (subject: string) => Promise<PushConfigResult>;
	/** 换一对新密钥：**所有旧订阅都会失效**，这里顺手清空，调用方提示各设备重订 */
	regenerateKeys: () => Promise<PushConfigResult & { cleared?: number }>;
	rename: (endpoint: string, name: string) => Promise<{ ok: true; total: number }>;
	/** 改这台设备的界面自称（空串 = 改回产品默认名） */
	setBrandName: (endpoint: string, brandName: string) => Promise<{ ok: true; total: number }>;
	removeOne: (endpoint: string) => Promise<{ ok: true; total: number }>;
	clear: () => Promise<{ ok: true; total: 0 }>;
	count: () => Promise<number>;
};

export function createPushStore(options: {
	dataDir: string;
	now: () => number;
	/** 推送失败时说话（网关给的原因比状态码有用得多，别只留个 `失败 403`） */
	log?: (message: string, meta?: Record<string, unknown>) => void;
}): PushStore {
	const path = join(options.dataDir, "push-subscriptions.json");
	/**
	 * VAPID 懒解析 + 只算一次（密钥 + subject 一对，因为 `setVapidDetails` 要一起吃）。
	 * 失败不缓存（清回 null），下次请求会重试 —— 否则一次磁盘满就把推送永久钉死。
	 */
	let vapidPromise: Promise<{ keys: VapidKeys; subject: { subject: string; source: VapidSubjectSource } }> | null =
		null;
	const vapid = (): NonNullable<typeof vapidPromise> => {
		if (!vapidPromise) {
			const pending = (async () => {
				const [keys, subject] = await Promise.all([loadVapidKeys(options.dataDir), loadVapidSubject(options.dataDir)]);
				webpush.setVapidDetails(subject.subject, keys.publicKey, keys.privateKey);
				return { keys, subject };
			})();
			vapidPromise = pending;
			pending.catch(() => {
				if (vapidPromise === pending) vapidPromise = null;
			});
		}
		return vapidPromise;
	};
	/** 把内部状态摊成界面看得懂的那份视图（私钥永远不出去） */
	const configView = async (): Promise<PushConfigView> => {
		const { keys, subject } = await vapid();
		return {
			publicKey: keys.publicKey,
			fingerprint: fingerprintOf(keys.publicKey),
			keySource: keys.source,
			keyCreatedAt: keys.createdAt,
			subject: subject.subject,
			subjectSource: subject.source,
			subjectValid: vapidSubjectProblem(subject.subject) === null,
			subjectProblem: vapidSubjectProblem(subject.subject),
			locked: {
				keys: keys.source === "env",
				subject: subject.source === "env" || Boolean(process.env.VAPID_SUBJECT),
			},
		};
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
		publicKey: async () => (await vapid()).keys.publicKey,
		config: configView,
		async saveSubject(subject) {
			const normalized = normalizeVapidSubject(subject);
			// 空串 = 清回兜底（不是「不合法」）；非空必须先过校验，否则存进去也只是下次 403
			const problem = normalized === "" ? null : vapidSubjectProblem(normalized);
			if (problem !== null) return { ok: false, code: problem };
			await saveVapidSubject(options.dataDir, normalized);
			vapidPromise = null; // 下次取用会重新读盘 + 重设 setVapidDetails
			return { ok: true, config: await configView() };
		},
		async regenerateKeys() {
			// 环境变量钉死时不能换：换了也不生效（下次读取又回到 env 那把），只会白清订阅
			if ((await vapid()).keys.source === "env") return { ok: false, code: "push.keys_locked" };
			await regenerateVapidKeys(options.dataDir);
			vapidPromise = null;
			// 旧订阅是用旧公钥订的，留着只会每次都失败（Apple 的 VapidPkHashMismatch 永不消）
			const cleared = (await read()).length;
			await write([]);
			options.log?.("已重新生成 VAPID 密钥，旧推送订阅已清空", { cleared });
			return { ok: true, config: await configView(), cleared };
		},
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
			await vapid();
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
					// 网关把真正的原因放在 body 里（`BadJwtToken` / `VapidPkHashMismatch`）。
					// 只记状态码的话，「iPhone 收不到」永远得靠人肉复现才能查。
					let host = "unknown";
					try {
						host = new URL(subscription.endpoint).host;
					} catch {
						// endpoint 坏了也照样记一条，至少说明是哪台设备
					}
					options.log?.("推送失败", {
						host,
						code: code ?? null,
						body: String((error as { body?: unknown }).body ?? "").slice(0, 200),
					});
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
