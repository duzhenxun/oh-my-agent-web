/**
 * 推送面板（独立 Tab，跟「模型 / 技能 / 设置」并列）。
 *
 * 两段：
 *   1. **本机注册**（顶部）：浏览器能力 / 通知权限 / Service Worker / 当前订阅状态，
 *      加上「注册推送 / 本地通知测试 / 取消订阅」三个按钮 —— 没有这一段，面板只能看
 *      「目标设备 0 台」，根本没法把当前浏览器订进去；
 *   2. 设备清单：别名 / endpoint（完整，可复制）/ 注册时间 / 上次推送结果，
 *      支持全选、只推选中的、重命名、删除、清空全部。
 */
import { useEffect, useState } from "react";
import {
	currentPushState,
	fetchPushConfig,
	pushSupported,
	regeneratePushKeys,
	savePushSubject,
	subscribePush,
	unsubscribePush,
	type PushConfig,
	type PushState,
} from "../push.ts";
import { tNow, useT } from "../use-language.ts";
import { useBrandName } from "../use-brand-name.ts";

type Device = {
	endpoint: string;
	host: string;
	name: string;
	createdAt: number;
	lastSentAt: number | null;
	lastStatus: string | null;
};

const relative = (ts: number | null): string => {
	if (!ts) return "—";
	const diff = Date.now() - ts;
	if (diff < 60_000) return tNow("刚刚", "just now");
	if (diff < 3_600_000) return tNow(`${Math.floor(diff / 60_000)} 分钟前`, `${Math.floor(diff / 60_000)} min ago`);
	if (diff < 86_400_000) return tNow(`${Math.floor(diff / 3_600_000)} 小时前`, `${Math.floor(diff / 3_600_000)} h ago`);
	return tNow(`${Math.floor(diff / 86_400_000)} 天前`, `${Math.floor(diff / 86_400_000)} d ago`);
};

/** 输入框里不显示 `mailto:` 前缀：用户填的是邮箱，不是 URI */
const editableSubject = (subject: string): string =>
	subject.toLowerCase().startsWith("mailto:") ? subject.slice("mailto:".length) : subject;

/**
 * 服务端拒收 subject 的三种原因，翻成人话。
 *
 * 为什么要专门解释 `host`：`localhost` / 内网名看着完全正常，但 Apple 的推送网关只接受
 * 带真实域名的 `mailto:` / `https:`，于是「电脑上能收、iPhone 静默 403」。
 */
const subjectProblemText = (code: string | null): string => {
	switch (code) {
		case "push.subject.scheme":
			return tNow(
				"只接受邮箱或 https 地址（推送网关不认 http / 其它协议）",
				"Only an email or an https URL is accepted (the push gateways reject http and other schemes)",
			);
		case "push.subject.host":
			return tNow(
				"域名要带真实后缀：localhost / 内网名 Apple 会直接拒（403 BadJwtToken）",
				"The domain needs a real suffix: Apple rejects localhost and LAN names outright (403 BadJwtToken)",
			);
		case "push.subject.empty":
			return tNow("不能为空", "Must not be empty");
		default:
			return tNow("格式不合法", "Invalid format");
	}
};

export function PushPanel() {
	const t = useT();
	// 通知标题用「这台设备上」的界面自称：设置 → 外观 改过名，本地测试通知与注册上报的名字都跟着改
	// （`name` 是显示用的名字，`custom` 是用户真起的那个 —— 上报给服务端的是后者，空串表示没改过）
	const { name: brandName, custom: customBrandName } = useBrandName();
	const [devices, setDevices] = useState<Device[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [message, setMessage] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	// 本机注册相关的状态（与设备清单分开：清单是服务端的，这一段是本浏览器的）
	const [pushState, setPushState] = useState<PushState>("default");
	const [pushBusy, setPushBusy] = useState(false);
	// 服务端 VAPID 状态（公钥指纹 / 来源 / 联系方式）：这台设备能不能收到，一半取决于它
	const [config, setConfig] = useState<PushConfig | null>(null);
	const [subjectDraft, setSubjectDraft] = useState("");
	const [configBusy, setConfigBusy] = useState(false);

	const refreshConfig = async () => {
		const next = await fetchPushConfig();
		setConfig(next);
		setSubjectDraft(next ? editableSubject(next.subject) : "");
	};

	const refreshPushState = async () => {
		try {
			setPushState(await currentPushState());
		} catch {
			setPushState("unsupported");
		}
	};

	const register = async () => {
		setPushBusy(true);
		setMessage(null);
		try {
			const result = await subscribePush(customBrandName);
			// 浏览器里那条旧订阅是旧公钥时会被重建（Apple 会一直 403 VapidPkHashMismatch），
			// 这件事得说出来——否则用户以为只是「又点了一次」。
			setMessage(
				result.ok
					? result.rekeyed
						? t("这台设备已按服务端新密钥重建订阅", "This device re-subscribed with the server's new key")
						: t("这台设备已注册推送", "Push registered for this device")
					: result.message,
			);
			if (result.ok) await load();
		} catch (error) {
			// 浏览器会在没有推送服务 / 未授权时直接抛（headless、内网 http 都会）
			setMessage(
				t(
					`注册失败：${error instanceof Error ? error.message : String(error)}（需要 https 或 localhost，且允许通知）`,
					`Registration failed: ${error instanceof Error ? error.message : String(error)} (needs https or localhost, and notifications allowed)`,
				),
			);
		} finally {
			setPushBusy(false);
			await refreshPushState();
		}
	};

	const unregister = async () => {
		setPushBusy(true);
		setMessage(null);
		try {
			const result = await unsubscribePush();
			setMessage(result.ok ? t("已取消这台设备的订阅", "Subscription cancelled for this device") : result.message);
			await load();
		} catch (error) {
			setMessage(
				t(
					`取消失败：${error instanceof Error ? error.message : String(error)}`,
					`Cancel failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		} finally {
			setPushBusy(false);
			await refreshPushState();
		}
	};

	/** 本地通知测试：不经过服务端，直接看「这台设备能不能弹出通知」 */
	const testLocal = async () => {
		try {
			if (!pushSupported()) {
				setMessage(
					t(
						"这个浏览器不支持通知（需要 https 或 localhost）",
						"This browser does not support notifications (needs https or localhost)",
					),
				);
				return;
			}
			const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
			if (permission !== "granted") {
				setMessage(t("通知权限没给，弹不出来", "Notification permission was not granted, so nothing can show"));
				return;
			}
			const reg = await navigator.serviceWorker.getRegistration("/sw.js");
			const options = {
				body: t(
					"这是本地通知测试，不经过服务端。",
					"This is a local notification test; it does not go through the server.",
				),
				icon: "/icons/icon-192.png",
				tag: "agent-web-local",
			};
			if (reg) await reg.showNotification(brandName, options);
			else new Notification(brandName, options);
			setMessage(
				t(
					"已发出本地通知（没看到的话检查系统通知设置）",
					"Local notification sent (check the system notification settings if you did not see it)",
				),
			);
		} catch (error) {
			setMessage(
				t(
					`本地通知失败：${error instanceof Error ? error.message : String(error)}`,
					`Local notification failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		}
	};

	/** 存联系方式（subject）：不影响任何已注册设备，改完立刻生效 */
	const saveContact = async () => {
		setConfigBusy(true);
		setMessage(null);
		try {
			const result = await savePushSubject(subjectDraft);
			if (!result.ok) {
				const problem = subjectProblemText(result.code);
				setMessage(t(`保存失败：${problem}`, `Save failed: ${problem}`));
				return;
			}
			setConfig(result.config);
			setSubjectDraft(editableSubject(result.config.subject));
			setMessage(t("联系方式已保存（不影响已注册的设备）", "Contact saved (registered devices are unaffected)"));
		} finally {
			setConfigBusy(false);
		}
	};

	/**
	 * 换一对新密钥：旧订阅全部作废（服务端已顺手清空），本机自动用新公钥重订。
	 * 其它设备得各自重按「注册推送」—— 确认框里必须先说清楚。
	 */
	const regenerate = async () => {
		if (
			!window.confirm(
				t(
					"换一对新密钥？所有已订阅设备都会失效（旧订阅会被清空），需要每台设备重新点「注册推送」。这台设备会自动重订。",
					"Replace the key pair? Every subscribed device stops working (old subscriptions are cleared) and each one has to register again. This device re-registers automatically.",
				),
			)
		)
			return;
		setConfigBusy(true);
		setMessage(null);
		try {
			const wasSubscribed = pushState === "subscribed";
			const result = await regeneratePushKeys();
			if (!result.ok) {
				setMessage(
					result.code === "push.keys_locked"
						? t(
								"密钥由环境变量 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 指定，要换得改环境变量",
								"The keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY; change them there",
							)
						: t(`换密钥失败：${result.code}`, `Replacing the keys failed: ${result.code}`),
				);
				return;
			}
			setConfig(result.config);
			setSubjectDraft(editableSubject(result.config.subject));
			await load();
			let tail = "";
			if (wasSubscribed) {
				const again = await subscribePush(customBrandName);
				tail = again.ok
					? t("本机已用新密钥重新注册", "This device re-registered with the new key")
					: t(`本机重订失败：${again.message}`, `Re-registering this device failed: ${again.message}`);
				await refreshPushState();
				await load();
			}
			setMessage(
				[
					t(
						`已换新密钥（清空 ${result.cleared} 台旧订阅）`,
						`Keys replaced (${result.cleared} old subscriptions cleared)`,
					),
					tail,
				]
					.filter((item) => item !== "")
					.join(t("；", "; ")),
			);
		} finally {
			setConfigBusy(false);
		}
	};

	const load = async () => {
		const response = await fetch("/api/push/subscriptions");
		const body = (await response.json()) as { devices?: Device[] };
		setDevices(body.devices ?? []);
		setSelected(
			(current) => new Set([...current].filter((item) => (body.devices ?? []).some((d) => d.endpoint === item))),
		);
	};

	useEffect(() => {
		void load();
		void refreshPushState();
		void refreshConfig();
	}, []);

	const act = async (path: string, init?: RequestInit) => {
		setBusy(true);
		try {
			await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, ...init });
			await load();
		} finally {
			setBusy(false);
		}
	};

	const toggle = (endpoint: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(endpoint)) next.delete(endpoint);
			else next.add(endpoint);
			return next;
		});

	const supported = pushSupported();
	const permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
	const permissionLabel =
		permission === "granted"
			? t("已允许", "Granted")
			: permission === "denied"
				? t("已拒绝", "Denied")
				: permission === "unsupported"
					? "—"
					: t("未授权", "Not granted");

	return (
		<div className="push-panel">
			{/* ---- 服务端 VAPID：公钥 / 来源 / 联系方式 ----
			     **服务端**的配置（不是本机偏好）：subject 存 `<dataDir>/push-config.json`，没配时用的是会被
			     Apple 拒的兜底值，所以它得能在这里改、能看见合不合法。
			     与「本机推送」同级并排在它前面：改的是这台服务器，不是这台浏览器。 */}
			<section className="push-env">
				<div className="push-env-title">{t("服务端密钥", "Server key")}</div>
				<div className="push-config-row">
					<span className="push-config-label">{t("公钥", "Public key")}</span>
					<span className="push-env-chip" title={config?.publicKey ?? ""}>
						<code className="mono">{config ? `${config.fingerprint}…` : "…"}</code>
						<em className={config?.keySource === "env" ? "push-tag-off" : "push-tag-ok"}>
							{config?.keySource === "env" ? t("环境变量", "env") : t("数据目录", "data dir")}
						</em>
					</span>
					{config?.keyCreatedAt ? (
						<span className="push-config-note">
							{t("生成于", "created")} {relative(config.keyCreatedAt)}
						</span>
					) : null}
					<span className="topbar-spacer" />
					<button
						type="button"
						className="btn btn-tiny btn-danger"
						disabled={configBusy || config?.locked.keys === true}
						title={
							config?.locked.keys
								? t("密钥由环境变量指定，要换得改环境变量", "Keys come from env vars; change them there")
								: undefined
						}
						onClick={() => void regenerate()}
					>
						{t("重新生成密钥", "Regenerate keys")}
					</button>
				</div>
				<div className="push-config-row">
					<span className="push-config-label">{t("联系方式", "Contact")}</span>
					<input
						className="push-config-input"
						type="text"
						inputMode="email"
						value={subjectDraft}
						placeholder="you@example.com"
						disabled={configBusy || config?.locked.subject === true}
						onChange={(event) => setSubjectDraft(event.target.value)}
						// Enter 就存：这一行只有一个输入框，没必要再去摸按钮
						onKeyDown={(event) => {
							if (event.key === "Enter") void saveContact();
						}}
					/>
					<button
						type="button"
						className="btn btn-tiny"
						disabled={configBusy || config === null || subjectDraft === editableSubject(config.subject)}
						onClick={() => void saveContact()}
					>
						{t("保存", "Save")}
					</button>
				</div>
				{config && !config.subjectValid ? (
					<div className="push-config-warn">⚠ {subjectProblemText(config.subjectProblem)}</div>
				) : null}
			</section>

			{/* ---- 本机注册（注册 / 取消订阅都在这里）---- */}
			<section className="push-env">
				<div className="push-env-title">{t("本机推送", "Push on this device")}</div>
				<div className="push-env-chips">
					<span className="push-env-chip">
						{t("浏览器支持", "Browser support")}
						<em className={supported ? "push-tag-ok" : "push-tag-off"}>
							{supported ? t("支持", "Supported") : t("不支持", "Unsupported")}
						</em>
					</span>
					<span className="push-env-chip">
						{t("通知权限", "Notification permission")}
						<em className={permission === "granted" ? "push-tag-ok" : "push-tag-off"}>{permissionLabel}</em>
					</span>
					<span className="push-env-chip">
						Service Worker
						<em className={pushState === "unsupported" ? "push-tag-off" : "push-tag-ok"}>
							{pushState === "unsupported" ? t("不可用", "Unavailable") : t("已就绪", "Ready")}
						</em>
					</span>
					<span className="push-env-chip">
						{t("当前订阅", "Subscription")}
						<em className={pushState === "subscribed" ? "push-tag-ok" : "push-tag-off"}>
							{pushState === "subscribed" ? t("已订阅", "Subscribed") : t("未订阅", "Not subscribed")}
						</em>
					</span>
				</div>
				<div className="push-env-actions">
					<button
						type="button"
						className="btn btn-tiny btn-primary-tiny"
						disabled={pushBusy}
						onClick={() => void register()}
					>
						{pushState === "subscribed" ? t("重新注册", "Register again") : t("注册推送", "Register for push")}
					</button>
					<button type="button" className="btn btn-tiny" disabled={pushBusy} onClick={() => void testLocal()}>
						{t("本地通知测试", "Local notification test")}
					</button>
					<button
						type="button"
						className="btn btn-tiny"
						disabled={pushBusy || pushState !== "subscribed"}
						onClick={() => void unregister()}
					>
						{t("取消订阅", "Unsubscribe")}
					</button>
				</div>
				<div className="side-panel-hint">
					{t(
						"推送需要 https 或 localhost（手机上请用域名）；注册后「目标设备」里会出现这台设备。",
						"Push needs https or localhost (use a domain name on phones); once registered, this device appears under Targets.",
					)}
				</div>
			</section>

			<section className="push-devices">
				<div className="push-head">
					<strong>{t("推送消息", "Push a message")}</strong>
					<span className="side-panel-count">
						{t("目标设备", "Targets")} {devices.length} {t("台", "devices")}
					</span>
					<span className="topbar-spacer" />
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => setSelected(new Set(devices.map((d) => d.endpoint)))}
					>
						{t("全选", "Select all")}
					</button>
					<button type="button" className="btn btn-tiny" onClick={() => setSelected(new Set())}>
						{t("全不选", "Select none")}
					</button>
					<button type="button" className="btn btn-tiny" onClick={() => void load()}>
						⟳ {t("刷新", "Refresh")}
					</button>
					<button
						type="button"
						className="btn btn-tiny btn-danger"
						onClick={() => {
							if (
								!window.confirm(
									t(
										"清空全部订阅设备？之后所有设备都收不到推送。",
										"Clear every subscribed device? No device will receive pushes afterwards.",
									),
								)
							)
								return;
							void act("/api/push/clear").then(() => setMessage(t("已清空全部设备", "All devices cleared")));
						}}
					>
						{t("清空全部设备", "Clear all devices")}
					</button>
				</div>

				{devices.length === 0 ? (
					<div className="side-panel-hint">
						{t(
							"还没有订阅设备。点上面的「注册推送」把当前这台浏览器订进来（需要 https 或 localhost）。",
							"No subscribed devices yet — use “Register for push” above to subscribe this browser (needs https or localhost).",
						)}
					</div>
				) : null}

				<div className="push-list">
					{devices.map((device) => (
						<div className={`push-row${selected.has(device.endpoint) ? " push-row-on" : ""}`} key={device.endpoint}>
							<input type="checkbox" checked={selected.has(device.endpoint)} onChange={() => toggle(device.endpoint)} />
							<div className="push-row-main">
								<div className="push-row-name">{device.name}</div>
								{/* 推送 endpoint 完整留着（排查、对照服务端日志都要用），单独一行、可选中复制；
							    不重复展示主机名，那一截在上面的 URL 里已经有了。
								    手机上是 `display: none`（见 styles/push.css）：一百多字符折六七行，太占地。 */}
								<div className="push-row-endpoint mono" title={device.endpoint}>
									{device.endpoint}
								</div>
								<div className="push-row-meta">
									{t("注册", "Registered")} {relative(device.createdAt)}
									{device.lastSentAt
										? ` · ${t("上次推送", "last push")} ${relative(device.lastSentAt)} (${device.lastStatus ?? "—"})`
										: ""}
								</div>
							</div>
							<button
								type="button"
								className="msg-action"
								onClick={() => {
									const name = window.prompt(t("设备别名", "Device alias"), device.name);
									if (name === null || name.trim() === "") return;
									void act("/api/push/rename", {
										body: JSON.stringify({ endpoint: device.endpoint, name: name.trim() }),
									});
								}}
							>
								重命名
							</button>
							<button
								type="button"
								className="msg-action"
								disabled={busy}
								onClick={() =>
									void act("/api/push/test", { body: JSON.stringify({ endpoints: [device.endpoint] }) }).then(() =>
										setMessage(t(`已单独推送给「${device.name}」`, `Pushed to “${device.name}” only`)),
									)
								}
							>
								{t("仅推它", "Push to this one")}
							</button>
							<button
								type="button"
								className="msg-action"
								onClick={() => void act("/api/push/delete", { body: JSON.stringify({ endpoint: device.endpoint }) })}
							>
								删除
							</button>
						</div>
					))}
				</div>

				<div className="push-foot">
					<button
						type="button"
						className="btn btn-tiny"
						disabled={busy}
						onClick={() =>
							void act("/api/push/test", {
								body: JSON.stringify(selected.size > 0 ? { endpoints: [...selected] } : {}),
							}).then(() =>
								setMessage(
									selected.size > 0
										? t(`已推送给选中的 ${selected.size} 台`, `Pushed to ${selected.size} selected devices`)
										: t("已推送给全部设备", "Pushed to all devices"),
								),
							)
						}
					>
						{t("推送测试消息", "Send a test push")}
						{selected.size > 0 ? ` (${selected.size} ${t("选中", "selected")})` : ` (${t("全部设备", "all devices")})`}
					</button>
					<span className="topbar-spacer" />
				</div>
			</section>

			{message ? <div className="side-ok">{message}</div> : null}
		</div>
	);
}
