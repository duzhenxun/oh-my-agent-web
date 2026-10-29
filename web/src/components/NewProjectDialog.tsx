import { useEffect, useState } from "react";
import { newChat } from "../ws.ts";
import { isWindowsHost } from "../path-utils.ts";
import { useT } from "../use-language.ts";
import { FolderIcon } from "./FolderIcon.tsx";

type DirEntry = { name: string; path: string };

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
				? `服务端上还没有这个接口（HTTP ${response.status}）—— 服务可能在跑旧版本，重启一下就好`
				: `服务端返回的不是 JSON（HTTP ${response.status}）`,
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
				setError(body.message ?? "这台机器上开不出目录选择框，请在下面直接浏览");
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
							if (event.key === "Enter") void load(input.trim());
						}}
						placeholder={isWindowsHost() ? "C:\\绝对路径" : "/绝对路径"}
					/>
					<button type="button" className="btn btn-tiny" onClick={() => void load(input.trim())} disabled={loading}>
						跳转
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
						{picking ? "📂 选择中…" : "📂 浏览电脑…"}
					</button>
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => void load(parent ?? undefined)}
						disabled={!parent || loading}
						title={t("回到上一级目录", "Go to the parent folder")}
					>
						↑ 上级目录
					</button>
					<span className="topbar-spacer" />
					<button
						type="button"
						className="btn btn-tiny btn-send"
						onClick={() => choose(path || input.trim())}
						disabled={loading || (path === "" && input.trim() === "")}
					>
						选择当前目录
					</button>
				</div>

				{error ? <div className="side-error">{error}</div> : null}
				<div className="new-project-list">
					{loading ? <div className="side-panel-hint">{t("读取中…")}</div> : null}
					{!loading && entries.length === 0 ? <div className="side-panel-hint">{t("这个目录下没有子目录")}</div> : null}
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
								选择
							</button>
						</div>
					))}
				</div>

				<div className="new-project-foot">
					<span className="side-panel-hint">
						「选择」= 在这个目录下新建一个会话（项目随之出现），不会创建或修改任何文件。
					</span>
				</div>
			</div>
		</div>
	);
}
