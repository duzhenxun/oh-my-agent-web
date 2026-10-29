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
import { currentPushState, pushSupported, subscribePush, unsubscribePush, type PushState } from "../push.ts";
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
			setMessage(result.ok ? t("这台设备已注册推送", "Push registered for this device") : result.message);
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
					<span className="side-panel-hint">
						{t(
							"回合结束会自动推一条：标题是项目名（拿不到项目名就用你的顶栏名称），正文是会话名",
							"A push is sent automatically when a turn ends: the title is the project name (or your top-bar name when there is none), the body is the conversation name",
						)}
					</span>
				</div>
			</section>

			{message ? <div className="side-ok">{message}</div> : null}
		</div>
	);
}
