/**
 * VAPID 密钥对与 subject（联系方式）的**取用 / 校验 / 落盘**。
 *
 * 从这里拆出来的原因：`push.ts` 已经在 400 行护栏边上，而「密钥从哪来、合不合法、
 * 改了要不要重启」是另一件事，跟「订阅怎么存、怎么推」没有耦合。
 *
 * 两样东西，两种生命周期，别混：
 *   - **密钥对**（`vapid-keys.json`，**0644：同机任何账户可读**，用户 2026-10-30 要求）：push 这个应用的身份证。**换掉 = 所有旧订阅作废**
 *     （浏览器把公钥 hash 绑在订阅里，Apple 会直接回 `VapidPkHashMismatch`）；
 *   - **subject**（`push-config.json`，0644）：只是「出事时怎么联系你」，填真实邮箱 / 站点地址。
 *     换掉**不影响**任何订阅，可以随手改。
 *
 * 优先级都是 **环境变量 > 数据目录里的文件 > 首次生成 / 兜底**。
 */
import { tempPathFor } from "../util/atomic-write.js";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import webpush from "web-push";
import { SHARED_FILE_MODE, chmodShared } from "../util/file-mode.js";

const KEYS_FILE = "vapid-keys.json";
const CONFIG_FILE = "push-config.json";

/**
 * 兜底 subject：**故意留一个会被 Apple 拒的值**（`localhost` 没有 TLD）。
 *
 * 不编一个假的 gmail / example.com 邮箱冒充「配好了」：那会让「推送为什么只有 iPhone 收不到」
 * 变成一个没人看得懂的 403。现在界面上会直接标红「subject 不合法」，让人填自己的邮箱。
 */
export const FALLBACK_VAPID_SUBJECT = "mailto:noreply@localhost";

export type VapidKeySource = "env" | "file";
export type VapidSubjectSource = "env" | "file" | "fallback";

/** subject 不合法时给界面的机器码（界面自己翻译，别在协议里传中文句子） */
type VapidSubjectProblem = "push.subject.empty" | "push.subject.scheme" | "push.subject.host";

export type VapidKeys = { publicKey: string; privateKey: string; source: VapidKeySource; createdAt: number | null };

/**
 * 把用户能贴进来的东西收敛成 subject。
 *
 * 面板里给的是一个「邮箱」输入框（人不会想手写 `mailto:`），但环境变量 / 老配置里
 * 可能就是完整的 `mailto:` 或 `https://` —— 这里都认。
 */
export function normalizeVapidSubject(raw: string): string {
	const text = raw.trim().replace(/\s+/g, "");
	if (text === "") return "";
	if (/^mailto:/i.test(text) || /^https?:\/\//i.test(text)) return text;
	if (text.includes("@")) return `mailto:${text}`;
	return text;
}

/** 域名必须带点：`localhost` / `myhost` 这类 Apple 不收（先把最迷惑的 403 挡在保存这一步） */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * 「像真域名」：带点，且顶级域里有字母。
 *
 * 后一条专门挡 `mailto:me@192.168.1.2`：它形状上是域名，但没有任何推送网关会把它当联系方式，
 * 而纯数字的「顶级域」在 DNS 里也不存在。
 */
function isRealHostname(host: string): boolean {
	if (!HOSTNAME.test(host)) return false;
	return /[a-z]/i.test(host.slice(host.lastIndexOf(".") + 1));
}

/**
 * subject 合不合法（不合法的结果就是「Chrome 能推、iPhone 403 BadJwtToken」）。
 *
 * 规则来自 web-push 与 Apple 的交集：只接受 `mailto:` 或 `https:`；邮箱域 / 站点域名要带点。
 * 不验证邮箱能不能收信、也不验证站点能不能访问 —— 那不是我们能查的，网关也不查。
 */
export function vapidSubjectProblem(subject: string): VapidSubjectProblem | null {
	const text = subject.trim();
	if (text === "") return "push.subject.empty";
	if (/^mailto:/i.test(text)) {
		const email = text.slice("mailto:".length).split("?")[0] ?? "";
		const at = email.lastIndexOf("@");
		if (at <= 0 || at === email.length - 1) return "push.subject.host";
		return isRealHostname(email.slice(at + 1)) ? null : "push.subject.host";
	}
	if (/^https:\/\//i.test(text)) {
		try {
			return isRealHostname(new URL(text).hostname) ? null : "push.subject.host";
		} catch {
			return "push.subject.host";
		}
	}
	// `http:` 也走这里：web-push 只认 https，别让人以为 http 站点能当 subject
	return "push.subject.scheme";
}

/** 公钥指纹：界面上只需要「能区分两把钥匙」，不用把 87 个字符全铺出来 */
export function fingerprintOf(publicKey: string): string {
	return publicKey.slice(0, 16);
}

/**
 * 对称读写一份 0644 的小 json（密钥与 config 各一份，规矩完全一样）。
 * `null` = 文件不存在或读不懂 —— 调用方自己决定「生成新的」还是「回兜底」。
 */
async function readSecretJson(path: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

async function writeSecretJson(path: string, value: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = tempPathFor(path);
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: SHARED_FILE_MODE });
	await rename(temporary, path);
	await chmodShared(path);
}

async function mtimeOf(path: string): Promise<number | null> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * 取（必要时生成）密钥对：环境变量 > `vapid-keys.json` > 生成一份落盘。
 *
 * **只有这里会「新生成」**：文件坏了 / 被人删了都会走生成，代价是所有旧订阅失效 ——
 * 这是无法避免的（私钥没了就签不出同样的 JWT），但界面上要能看见「来源」，
 * 否则用户只会看到一堆 `失败 403` 却不知道为什么。
 */
export async function loadVapidKeys(dataDir: string): Promise<VapidKeys> {
	const envPublic = process.env.VAPID_PUBLIC_KEY ?? "";
	const envPrivate = process.env.VAPID_PRIVATE_KEY ?? "";
	if (envPublic !== "" && envPrivate !== "") {
		return { publicKey: envPublic, privateKey: envPrivate, source: "env", createdAt: null };
	}

	const path = join(dataDir, KEYS_FILE);
	const parsed = await readSecretJson(path);
	if (typeof parsed?.publicKey === "string" && typeof parsed.privateKey === "string") {
		return {
			publicKey: parsed.publicKey,
			privateKey: parsed.privateKey,
			source: "file",
			createdAt: await mtimeOf(path),
		};
	}

	const generated = webpush.generateVAPIDKeys();
	await writeSecretJson(path, { publicKey: generated.publicKey, privateKey: generated.privateKey });
	return { ...generated, source: "file", createdAt: await mtimeOf(path) };
}

/** 换一对新的（界面上是红按钮）：**所有已订阅设备都会失效**，调用方要负责清订阅 / 提示重订 */
export async function regenerateVapidKeys(dataDir: string): Promise<VapidKeys> {
	const generated = webpush.generateVAPIDKeys();
	const path = join(dataDir, KEYS_FILE);
	await writeSecretJson(path, { publicKey: generated.publicKey, privateKey: generated.privateKey });
	// 环境变量优先：设了 env 就等于「密钥不归这个文件管」，界面上会显示来源=环境变量并禁用这个按钮
	return { ...generated, source: "file", createdAt: await mtimeOf(path) };
}

/** 取 subject：环境变量 > `push-config.json` > 兜底（兜底那个 Apple 会拒，界面会标红） */
export async function loadVapidSubject(dataDir: string): Promise<{ subject: string; source: VapidSubjectSource }> {
	const fromEnv = process.env.VAPID_SUBJECT ?? "";
	if (fromEnv !== "") return { subject: normalizeVapidSubject(fromEnv), source: "env" };
	const parsed = await readSecretJson(join(dataDir, CONFIG_FILE));
	if (typeof parsed?.subject === "string" && parsed.subject.trim() !== "") {
		return { subject: normalizeVapidSubject(parsed.subject), source: "file" };
	}
	return { subject: FALLBACK_VAPID_SUBJECT, source: "fallback" };
}

/**
 * 存 subject（**不影响订阅**，改完立刻生效）。
 *
 * 传空串 = 删掉这条配置、回到兜底 —— 界面上「清空输入框再保存」就是这个意思。
 */
export async function saveVapidSubject(dataDir: string, subject: string): Promise<void> {
	const path = join(dataDir, CONFIG_FILE);
	const normalized = normalizeVapidSubject(subject);
	if (normalized === "") {
		await writeSecretJson(path, {});
		return;
	}
	await writeSecretJson(path, { subject: normalized });
}
