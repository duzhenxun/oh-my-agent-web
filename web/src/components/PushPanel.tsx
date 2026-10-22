import { BRAND_NAME } from "../brand.ts";
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
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	return `${Math.floor(diff / 86_400_000)} 天前`;
};

export function PushPanel() {
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
			const result = await subscribePush();
			setMessage(result.ok ? "这台设备已注册推送" : result.message);
			if (result.ok) await load();
		} catch (error) {
			// 浏览器会在没有推送服务 / 未授权时直接抛（headless、内网 http 都会）
			setMessage(
				`注册失败：${error instanceof Error ? error.message : String(error)}（需要 https 或 localhost，且允许通知）`,
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
			setMessage(result.ok ? "已取消这台设备的订阅" : result.message);
			await load();
		} catch (error) {
			setMessage(`取消失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setPushBusy(false);
			await refreshPushState();
		}
	};

	/** 本地通知测试：不经过服务端，直接看「这台设备能不能弹出通知」 */
	const testLocal = async () => {
		try {
			if (!pushSupported()) {
				setMessage("这个浏览器不支持通知（需要 https 或 localhost）");
				return;
			}
			const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
			if (permission !== "granted") {
				setMessage("通知权限没给，弹不出来");
				return;
			}
			const reg = await navigator.serviceWorker.getRegistration("/sw.js");
			const options = { body: "这是本地通知测试，不经过服务端。", icon: "/icons/icon-192.png", tag: "agent-web-local" };
			if (reg) await reg.showNotification(BRAND_NAME, options);
			else new Notification(BRAND_NAME, options);
			setMessage("已发出本地通知（没看到的话检查系统通知设置）");
		} catch (error) {
			setMessage(`本地通知失败：${error instanceof Error ? error.message : String(error)}`);
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
			? "已允许"
			: permission === "denied"
				? "已拒绝"
				: permission === "unsupported"
					? "—"
					: "未授权";

	return (
		<div className="push-panel">
			{/* ---- 本机注册（注册 / 取消订阅都在这里）---- */}
			<section className="push-env">
				<div className="push-env-title">本机推送</div>
				<div className="push-env-chips">
					<span className="push-env-chip">
						浏览器支持
						<em className={supported ? "push-tag-ok" : "push-tag-off"}>{supported ? "支持" : "不支持"}</em>
					</span>
					<span className="push-env-chip">
						通知权限
						<em className={permission === "granted" ? "push-tag-ok" : "push-tag-off"}>{permissionLabel}</em>
					</span>
					<span className="push-env-chip">
						Service Worker
						<em className={pushState === "unsupported" ? "push-tag-off" : "push-tag-ok"}>
							{pushState === "unsupported" ? "不可用" : "已就绪"}
						</em>
					</span>
					<span className="push-env-chip">
						当前订阅
						<em className={pushState === "subscribed" ? "push-tag-ok" : "push-tag-off"}>
							{pushState === "subscribed" ? "已订阅" : "未订阅"}
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
						{pushState === "subscribed" ? "重新注册" : "注册推送"}
					</button>
					<button type="button" className="btn btn-tiny" disabled={pushBusy} onClick={() => void testLocal()}>
						本地通知测试
					</button>
					<button
						type="button"
						className="btn btn-tiny"
						disabled={pushBusy || pushState !== "subscribed"}
						onClick={() => void unregister()}
					>
						取消订阅
					</button>
				</div>
				<div className="side-panel-hint">
					推送需要 https 或 localhost（手机上请用域名）；注册后「目标设备」里会出现这台设备。
				</div>
			</section>

			<section className="push-devices">
				<div className="push-head">
					<strong>推送消息</strong>
					<span className="side-panel-count">目标设备 {devices.length} 台</span>
					<span className="topbar-spacer" />
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => setSelected(new Set(devices.map((d) => d.endpoint)))}
					>
						全选
					</button>
					<button type="button" className="btn btn-tiny" onClick={() => setSelected(new Set())}>
						全不选
					</button>
					<button type="button" className="btn btn-tiny" onClick={() => void load()}>
						⟳ 刷新
					</button>
					<button
						type="button"
						className="btn btn-tiny btn-danger"
						onClick={() => {
							if (!window.confirm("清空全部订阅设备？之后所有设备都收不到推送。")) return;
							void act("/api/push/clear").then(() => setMessage("已清空全部设备"));
						}}
					>
						清空全部设备
					</button>
				</div>

				{devices.length === 0 ? (
					<div className="side-panel-hint">
						还没有订阅设备。点上面的「注册推送」把当前这台浏览器订进来（需要 https 或 localhost）。
					</div>
				) : null}

				<div className="push-list">
					{devices.map((device) => (
						<div className={`push-row${selected.has(device.endpoint) ? " push-row-on" : ""}`} key={device.endpoint}>
							<input type="checkbox" checked={selected.has(device.endpoint)} onChange={() => toggle(device.endpoint)} />
							<div className="push-row-main">
								<div className="push-row-name">{device.name}</div>
								{/* 推送 endpoint 完整留着（排查、对照服务端日志都要用），单独一行、可选中复制；
							    不重复展示主机名，那一截在上面的 URL 里已经有了。 */}
								<div className="push-row-endpoint mono" title={device.endpoint}>
									{device.endpoint}
								</div>
								<div className="push-row-meta">
									注册 {relative(device.createdAt)}
									{device.lastSentAt ? ` · 上次推送 ${relative(device.lastSentAt)}（${device.lastStatus ?? "—"}）` : ""}
								</div>
							</div>
							<button
								type="button"
								className="msg-action"
								onClick={() => {
									const name = window.prompt("设备别名", device.name);
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
										setMessage(`已单独推送给「${device.name}」`),
									)
								}
							>
								仅推它
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
							}).then(() => setMessage(selected.size > 0 ? `已推送给选中的 ${selected.size} 台` : "已推送给全部设备"))
						}
					>
						推送测试消息{selected.size > 0 ? `（选中 ${selected.size} 台）` : "（全部设备）"}
					</button>
					<span className="topbar-spacer" />
					<span className="side-panel-hint">回合结束会自动推一条：标题是项目名，正文是会话名</span>
				</div>
			</section>

			{message ? <div className="side-ok">{message}</div> : null}
		</div>
	);
}
