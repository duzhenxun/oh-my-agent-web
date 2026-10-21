/**
 * 推送面板（独立 Tab，跟「模型 / 技能 / 设置」并列）。
 *
 * 展示已订阅设备：别名 / endpoint 主机 / 注册时间 / 上次推送结果，
 * 支持全选、只推选中的、重命名、删除、清空全部。
 */
import { useEffect, useState } from "react";

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

	return (
		<div className="push-panel">
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
					还没有订阅设备。在同一个浏览器里点下面的「订阅这台设备」即可（需要 https 或 localhost）。
				</div>
			) : null}

			<div className="push-list">
				{devices.map((device) => (
					<div className={`push-row${selected.has(device.endpoint) ? " push-row-on" : ""}`} key={device.endpoint}>
						<input type="checkbox" checked={selected.has(device.endpoint)} onChange={() => toggle(device.endpoint)} />
						<div className="push-row-main">
							<div className="push-row-name">{device.name}</div>
							<div className="push-row-meta mono">
								{device.endpoint.slice(0, 42)}… · {device.host} · 注册 {relative(device.createdAt)}
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
				<span className="side-panel-hint">回合结束时也会自动推一条「回合完成」</span>
			</div>

			{message ? <div className="side-ok">{message}</div> : null}
		</div>
	);
}
