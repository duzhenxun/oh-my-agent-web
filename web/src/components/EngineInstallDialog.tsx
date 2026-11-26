import { useEffect, useRef, useState } from "react";
import { useT } from "../use-language.ts";

/**
 * 「这个引擎还没装」的弹窗（ADR-0052）。
 *
 * 什么时候出现：**只有用户主动切到一个没装的引擎时**。不主动弹 —— 默认引擎是 pi，
 * 大多数人不换引擎，就不该被一个「要不要安装」打扰。
 *
 * 装不装由人决定：按钮点了才发 `/api/engines/install`，装到 `<dataDir>` 这个
 * npm prefix（`install.sh` 同款，不碰系统全局、不用 sudo）。dsh 没有公开 npm 包，
 * 这里就不给安装按钮，只把去向写清楚。
 */
type EngineStatus = {
	name: string;
	label: string;
	installed: boolean;
	installable: boolean;
	guide: string[];
	afterInstall?: string;
};

export function EngineInstallDialog({
	engine,
	onClose,
	onInstalled,
}: {
	engine: { name: string; label: string };
	onClose: () => void;
	onInstalled: () => void;
}) {
	const t = useT();
	const [installing, setInstalling] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; message: string; restartRequired: boolean } | null>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	/** 服务端给的「怎么装」：兜底文案，也是展示给「想自己装」的人看的 */
	const [status, setStatus] = useState<EngineStatus | null>(null);

	useEffect(() => {
		void fetch("/api/engines")
			.then(async (response) => (response.ok ? ((await response.json()) as { engines: EngineStatus[] }) : null))
			.then((body) => {
				const found = body?.engines.find((item) => item.name === engine.name) ?? null;
				setStatus(found);
			})
			.catch(() => undefined);
	}, [engine.name]);

	useEffect(() => {
		closeRef.current?.focus();
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !installing) onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [installing, onClose]);

	const install = async () => {
		setInstalling(true);
		setResult(null);
		try {
			const response = await fetch("/api/engines/install", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: engine.name }),
			});
			const body = (await response.json()) as { ok?: boolean; message?: string; restartRequired?: boolean };
			const ok = response.ok && body.ok === true;
			setResult({
				ok,
				message: body.message ?? (ok ? t("装好了", "Installed") : t("安装失败", "Install failed")),
				restartRequired: body.restartRequired === true,
			});
			if (ok) onInstalled();
		} catch (error) {
			setResult({
				ok: false,
				restartRequired: false,
				message: t(
					`安装请求失败：${error instanceof Error ? error.message : String(error)}`,
					`Install request failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			});
		} finally {
			setInstalling(false);
		}
	};

	// 装完 pi 要重启（它是模块，当前进程已经加载失败过了）；其余引擎挂上 PATH 就能用
	const restartRequired = result?.ok === true && result.restartRequired;

	return (
		<div
			className="modal-backdrop"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="engine-install-title"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !installing) onClose();
			}}
		>
			<div className="modal">
				<h2 className="modal-title" id="engine-install-title">
					{t(`还没装 ${engine.label}`, `${engine.label} is not installed`)}
				</h2>
				<p className="modal-risk">
					{t(
						`切到 ${engine.label} 需要它自己的命令行程序，这台机器上没找到。`,
						`Switching to ${engine.label} needs its own CLI, and it is not on this machine.`,
					)}
				</p>
				<p>
					{t(
						"装了才会启动它；不装的话继续用 pi 就行，什么时候想用再装。",
						"Installing lets it start. If you skip it, keep using pi and install whenever you want.",
					)}
				</p>

				{result ? (
					<p className={result.ok ? "modal-ok" : "modal-risk"}>{result.message}</p>
				) : status && status.guide.length > 0 ? (
					<p className="modal-hint">
						{t(
							"装到 ~/.oh-my-agent-web（你自己的 npm 目录，不碰系统、不用 sudo）。",
							"Installs into ~/.oh-my-agent-web (your own npm prefix — no system changes, no sudo).",
						)}
						{status.afterInstall ? ` ${t(status.afterInstall)}` : ""}
					</p>
				) : null}

				<div className="modal-actions">
					<button ref={closeRef} type="button" className="btn" onClick={onClose} disabled={installing}>
						{restartRequired ? t("关闭", "Close") : t("以后再装", "Not now")}
					</button>
					{status?.installable === false ? null : (
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => void install()}
							disabled={installing || result?.ok === true}
						>
							{installing ? t("正在安装…", "Installing…") : t(`安装 ${engine.label}`, `Install ${engine.label}`)}
						</button>
					)}
				</div>
				{status?.installable === false ? (
					<p className="modal-hint">
						{t(
							"这个引擎没有公开的 npm 包，只能你自己装：",
							"This engine has no public npm package — install it yourself:",
						)}
						{status.guide.join("；")}
					</p>
				) : null}
			</div>
		</div>
	);
}
