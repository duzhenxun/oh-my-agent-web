/**
 * 访问密码（「设置 → 远程」里那个输入框）：只在**本机**能读状态 / 改密码。
 *
 * 为什么要有它（用户 2026-10-30）：
 *   「需要远程访问时，那个密码不用系统变量；密码保存在 ~/.oh-my-agent-web 下面的配置里，
 *     在访问 127.0.0.1 时于 设置/远程 里增加密码输入框进行设置。」
 *
 * 服务端对这两条端点只认「对端回环 + Host 回环」（`server/http/auth-routes.ts` 的
 * `GET/POST /api/auth/password`）：
 *   - GET  只回 `{ set }`，绝不回显密码；
 *   - POST 落盘到 `<dataDir>/password`，立即生效，不用重启。
 * 远程（域名 / 局域网 IP / 隧道）来问只会拿到 403 —— 这里也就不显示表单。
 */
import { tNow } from "./use-language.ts";

/** 「登录保护」的两个旋钮：连续输错几次 → 暂停多少分钟（服务端默认 3 / 30） */
export type LoginGuardSettings = { maxFailures: number; lockMinutes: number };

export const DEFAULT_LOGIN_GUARD_SETTINGS: LoginGuardSettings = { maxFailures: 3, lockMinutes: 30 };

/** 「读状态」带回登录保护阀值；「改密码」只关心成没成 */
type PasswordResult = { ok: true; set: boolean; guard: LoginGuardSettings } | { ok: false; error: string };
type PasswordSaveResult = { ok: true } | { ok: false; error: string };

/** 把服务端回的两个数字读出来；旧版服务端没这两项时用默认值（不报错） */
function guardOf(body: Record<string, unknown> | null): LoginGuardSettings {
	const maxFailures =
		typeof body?.maxFailures === "number" ? body.maxFailures : DEFAULT_LOGIN_GUARD_SETTINGS.maxFailures;
	const lockMinutes =
		typeof body?.lockMinutes === "number" ? body.lockMinutes : DEFAULT_LOGIN_GUARD_SETTINGS.lockMinutes;
	return { maxFailures, lockMinutes };
}

/** 从响应里取 body；取不到（HTML / 网络层问题）时给 null，不抛错 */
async function readBody(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const body: unknown = await response.json();
		return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function errorOf(body: Record<string, unknown> | null, status: number): string {
	return typeof body?.error === "string" && body.error !== ""
		? body.error
		: tNow(`请求失败（HTTP ${status}）`, `Request failed (HTTP ${status})`);
}

/** 现在有没有设访问密码（只回布尔值）+ 「登录保护」当前的阀值 */
export async function fetchAccessPasswordStatus(): Promise<PasswordResult> {
	try {
		const response = await fetch("/api/auth/password", { cache: "no-store", credentials: "same-origin" });
		const body = await readBody(response);
		if (!response.ok || body?.ok !== true) return { ok: false, error: errorOf(body, response.status) };
		return { ok: true, set: body.set === true, guard: guardOf(body) };
	} catch {
		return { ok: false, error: tNow("网络异常，请重试", "Network error — try again") };
	}
}

/**
 * 设置 / 修改访问密码：保存后立即生效（服务端写 `<dataDir>/password` 并换掉内存里的那份）。
 * 长度校验服务端也有一份（4–200）；这里先挡一下，省一次往返。
 */
export async function saveAccessPassword(password: string): Promise<PasswordSaveResult> {
	try {
		const response = await fetch("/api/auth/password", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password }),
			cache: "no-store",
			credentials: "same-origin",
		});
		const body = await readBody(response);
		if (!response.ok || body?.ok !== true) return { ok: false, error: errorOf(body, response.status) };
		return { ok: true };
	} catch {
		return { ok: false, error: tNow("网络异常，请重试", "Network error — try again") };
	}
}

/**
 * 保存「登录保护」（连续错几次 / 暂停多久）。
 *
 * 只在本机能改（服务端 `POST /api/auth/guard` 也只认本机），改完落盘、立即生效：
 * 已经在锁里的来源不会因为改了数字而解开（改密码才会 `clearAll`）。
 * 范围校验客户端先挡一道，省一次往返（服务端 `login-guard.ts` 里还有一份）。
 */
export async function saveLoginGuard(
	settings: LoginGuardSettings,
): Promise<{ ok: true; guard: LoginGuardSettings } | { ok: false; error: string }> {
	try {
		const response = await fetch("/api/auth/guard", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(settings),
			cache: "no-store",
			credentials: "same-origin",
		});
		const body = await readBody(response);
		if (!response.ok || body?.ok !== true) return { ok: false, error: errorOf(body, response.status) };
		return { ok: true, guard: guardOf(body) };
	} catch {
		return { ok: false, error: tNow("网络异常，请重试", "Network error — try again") };
	}
}
