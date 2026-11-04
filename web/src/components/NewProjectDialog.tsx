import { useEffect, useState } from "react";
import { newChat } from "../ws.ts";
import { isWindowsHost } from "../path-utils.ts";
import { tNow, useT } from "../use-language.ts";
import { FolderIcon } from "./FolderIcon.tsx";

type DirEntry = { name: string; path: string };

/**
 * 「复制文件地址」粘进来的是带引号的 `"C:\Users\me"`，手输时也可能带着引号 ——
 * 服务端也会剥一次，这里做一遍是为了让**输入框里显示的**和**真去打开的**是同一个东西。
 */
function cleanPath(value: string): string {
	let text = value.trim();
	for (const quote of ['"', "'"]) {
		if (text.length >= 2 && text.startsWith(quote) && text.endsWith(quote)) text = text.slice(1, -1).trim();
	}
	// 只写了盘符（`C:`）不算绝对路径，补上根分隔符
	return /^[A-Za-z]:$/.test(text) ? `${text}\\` : text;
}

/**
 * 读一个 JSON 响应，**但先看它到底是不是 JSON**。
 *
 * 为什么需要：服务端在跑的可能是旧构建（没有这个接口），那时请求会落到 SPA 的静态兜底，
 * 回一页 HTML —— 直接 `response.json()` 就报 `Unexpected token '<'`，用户只看得到一句天书。
 * 这里把它们变成一句能行动的话。
 */
async function readJson<T>(response: Response): Promise<{ ok: true; body: T } | { ok: false; message: string }> {
	const text = await response.text();
	try {
		return { ok: true, body: JSON.parse(text) as T };
	} catch {
		const looksLikeHtml = text.trimStart().startsWith("<");
		return {
			ok: false,
			message: looksLikeHtml
				? tNow(
						`服务端上还没有这个接口（HTTP ${response.status}）—— 服务可能在跑旧版本，重启一下就好`,
						`The server does not have this endpoint yet (HTTP ${response.status}) — it may be an older build, restart it`,
					)
				: tNow(
						`服务端返回的不是 JSON（HTTP ${response.status}）`,
						`The server did not return JSON (HTTP ${response.status})`,
					),
		};
	}
}

/**
 * 「新建项目」的目录选择器。
 *
 * 在本项目里「项目」= 一个有 pi 会话的工作区目录（ADR-0021）：
 * 所以「选择当前目录」= 在这个目录下**指向一条新会话**，项目随之出现。
 * 我们不创建目录、不写文件，只选已有目录。
 *
 * 选完之后干什么由 `onPick` 决定：不传就是老行为（立刻建一条会话，`newChat`）；
 * 「新会话草稿态」那一行（`NewSessionScope`）传自己的——只把待建会话指向这个目录，
 * 等用户发第一条消息时才真建（不然建完项目就多一条空会话）。
 */
export function NewProjectDialog({ onClose, onPick }: { onClose: () => void; onPick?: (cwd: string) => void }) {
	const t = useT();
	const [path, setPath] = useState<string>("");
	const [input, setInput] = useState<string>("");
	const [parent, setParent] = useState<string | null>(null);
	const [entries, setEntries] = useState<DirEntry[]>([]);
	/** Windows 的盘符列表（其它平台是空数组）：到了盘根就上不去了，切盘只能靠这一行 */
	const [drives, setDrives] = useState<DirEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	/** 原生选择框开着的时候：按钮要禁掉，否则能点出两个对话框 */
	const [picking, setPicking] = useState(false);

	const load = async (target?: string) => {
		setLoading(true);
		setError(null);
		try {
			const response = await fetch(`/api/fs/dirs${target ? `?path=${encodeURIComponent(target)}` : ""}`);
			// 跟下面的「浏览电脑…」用同一套解析：旧服务端回一页 HTML 时说人话，不是 `Unexpected token '<'`
			const parsed = await readJson<{
				path?: string;
				parent?: string | null;
				entries?: DirEntry[];
				drives?: DirEntry[];
				error?: { message?: string };
			}>(response);
			if (!parsed.ok) {
				setError(parsed.message);
				return;
			}
			const body = parsed.body;
			if (!response.ok) {
				setError(body.error?.message ?? `HTTP ${response.status}`);
				return;
			}
			setPath(body.path ?? "");
			setInput(body.path ?? "");
			setParent(body.parent ?? null);
			setEntries(body.entries ?? []);
			setDrives(body.drives ?? []);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void load();
	}, []);

	const choose = (target: string) => {
		if (onPick) onPick(target);
		else newChat(target);
		onClose();
	};

	/** 输入框 → 服务端：先剥引号 / 补盘符根，不然粘贴进来的路径会被当成「没跳转」 */
	const go = (value: string) => void load(cleanPath(value));

	/**
	 * 在**服务端那台电脑**上弹原生目录选择框（浏览器拿不到本机绝对路径）。
	 * 开不出来（无图形会话 / 平台不支持）就如实说一句，并留在内置浏览里 —— 不假装成功。
	 */
	const browse = async () => {
		setPicking(true);
		setError(null);
		try {
			const response = await fetch("/api/fs/pick-dir", { method: "POST" });
			const parsed = await readJson<{
				path?: string;
				canceled?: boolean;
				unsupported?: boolean;
				message?: string;
				error?: { message?: string };
			}>(response);
			if (!parsed.ok) {
				setError(parsed.message);
				return;
			}
			const body = parsed.body;
			if (!response.ok) {
				setError(body.error?.message ?? body.message ?? `HTTP ${response.status}`);
				return;
			}
			if (body.unsupported) {
				setError(
					body.message ??
						t(
							"这台机器上开不出目录选择框，请在下面直接浏览",
							"No folder picker on this machine — browse below instead",
						),
				);
				return;
			}
			// 取消：什么都不做（不要清掉当前路径）
			if (!body.path) return;
			choose(body.path);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setPicking(false);
		}
	};

	return (
		<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t("新建项目")}>
			<div className="modal new-project">
				<div className="new-project-head">
					<strong>{t("🗂 本地目录")}</strong>
					<span className="topbar-spacer" />
					<button type="button" className="btn btn-tiny" onClick={onClose} title={t("关闭")}>
						✕
					</button>
				</div>

				{/*
				 * 路径区**分两行**，不再挤在一行 flex-wrap 里：
				 * 以前六个控件同排，窗口一窄「选择当前目录」（最想点的那个）就折到第二行最左边，
				 * 看着就像布局坏了 —— 用户「总感觉有点问题」就是这一处。
				 * 现在：第一行只放「在哪儿」，第二行放「做什么」，主按钮固定贴右。
				 */}
				<div className="new-project-bar">
					<input
						className="new-project-input mono"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") go(input);
						}}
						placeholder={isWindowsHost() ? t("C:\\绝对路径", "C:\\absolute\\path") : t("/绝对路径", "/absolute/path")}
					/>
					<button type="button" className="btn btn-tiny" onClick={() => go(input)} disabled={loading}>
						{t("跳转", "Go")}
					</button>
				</div>
				<div className="new-project-actions">
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => void browse()}
						disabled={picking}
						title={t(
							"在服务端所在的电脑上打开系统自带的文件夹选择框",
							"Open your computer's own folder picker (on the machine running the server)",
						)}
					>
						{picking ? t("📂 选择中…", "📂 Choosing…") : t("📂 浏览电脑…", "📂 Browse computer…")}
					</button>
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => void load(parent ?? undefined)}
						disabled={!parent || loading}
						title={t("回到上一级目录", "Go to the parent folder")}
					>
						{t("↑ 上级目录", "↑ Up one level")}
					</button>
					<span className="topbar-spacer" />
					<button
						type="button"
						className="btn btn-tiny btn-send"
						onClick={() => choose(path || cleanPath(input))}
						disabled={loading || (path === "" && input.trim() === "")}
					>
						{t("选择当前目录", "Use this folder")}
					</button>
				</div>

				{error ? <div className="side-error">{error}</div> : null}
				{/* 原生框在**服务端那台电脑**上弹，可能被浏览器挡住 —— 干等着转圈最难受，直接给找回来的办法 */}
				{picking ? (
					<div className="side-panel-hint">
						{t(
							"文件夹选择框已经在你电脑上打开，如果没看到，它可能被浏览器/别的窗口挡住了（Alt+Tab 找一下）",
							"The folder picker is open on your computer — if you can't see it, it may be behind another window (Alt+Tab)",
						)}
					</div>
				) : null}
				{/* 切盘：Windows 没有统一的树根，到了 C:\ 就上不去了，这一行是唯一的「去 D 盘」入口 */}
				{drives.length > 1 ? (
					<div className="new-project-drives">
						{drives.map((drive) => (
							<button
								key={drive.path}
								type="button"
								className={`btn btn-tiny${drive.path === path ? " is-current" : ""}`}
								onClick={() => void load(drive.path)}
								title={drive.path}
							>
								{drive.name}
							</button>
						))}
					</div>
				) : null}
				<div className="new-project-list">
					{loading ? <div className="side-panel-hint">{t("读取中…")}</div> : null}
					{!loading && entries.length === 0 ? (
						<div className="side-panel-hint">
							{t("这个目录下没有子目录", "No subfolders here")}
							{parent ? t(" —— 可以点上面的「↑ 上级目录」往外走", " — use ↑ Up one level above") : null}
						</div>
					) : null}
					{entries.map((entry) => (
						<div className="new-project-row" key={entry.path}>
							<button
								type="button"
								className="new-project-name"
								onClick={() => void load(entry.path)}
								title={entry.path}
							>
								{/* 图标跟项目下拉框里的一致（不用 📁 emoji：大小/配色跟旁边按钮对不上） */}
								<span className="new-project-icon" aria-hidden="true">
									<FolderIcon open={false} />
								</span>
								{entry.name}
							</button>
							<button type="button" className="btn btn-tiny" onClick={() => choose(entry.path)}>
								{t("选择", "Choose")}
							</button>
						</div>
					))}
				</div>

				<div className="new-project-foot">
					<span className="side-panel-hint">
						{t(
							"「选择」= 在这个目录下新建一个会话（项目随之出现），不会创建或修改任何文件。",
							"Choose = start a new conversation in this folder (the project appears with it); no files are created or changed.",
						)}
					</span>
				</div>
			</div>
		</div>
	);
}
