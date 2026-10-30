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

type PasswordResult = { ok: true; set: boolean } | { ok: false; error: string };

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
	return typeof body?.error === "string" && body.error !== "" ? body.error : `请求失败（HTTP ${status}）`;
}

/** 现在有没有设访问密码（只回布尔值） */
export async function fetchAccessPasswordStatus(): Promise<PasswordResult> {
	try {
		const response = await fetch("/api/auth/password", { cache: "no-store", credentials: "same-origin" });
		const body = await readBody(response);
		if (!response.ok || body?.ok !== true) return { ok: false, error: errorOf(body, response.status) };
		return { ok: true, set: body.set === true };
	} catch {
		return { ok: false, error: "网络异常，请重试" };
	}
}

/**
 * 设置 / 修改访问密码：保存后立即生效（服务端写 `<dataDir>/password` 并换掉内存里的那份）。
 * 长度校验服务端也有一份（4–200）；这里先挡一下，省一次往返。
 */
export async function saveAccessPassword(password: string): Promise<PasswordResult> {
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
		return { ok: true, set: true };
	} catch {
		return { ok: false, error: "网络异常，请重试" };
	}
}
