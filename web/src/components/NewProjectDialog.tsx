import { useEffect, useState } from "react";
import { newChat } from "../ws.ts";

type DirEntry = { name: string; path: string };

/**
 * 「新建项目」（对齐参考实现的目录选择器）。
 *
 * 在本项目里「项目」= 一个有 pi 会话的工作区目录（ADR-0021）：
 * 所以「选择当前目录」= 在这个目录下**新建一个会话**，项目随之出现。
 * 我们不创建目录、不写文件，只选已有目录。
 */
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
	const [path, setPath] = useState<string>("");
	const [input, setInput] = useState<string>("");
	const [parent, setParent] = useState<string | null>(null);
	const [entries, setEntries] = useState<DirEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const load = async (target?: string) => {
		setLoading(true);
		setError(null);
		try {
			const response = await fetch(`/api/fs/dirs${target ? `?path=${encodeURIComponent(target)}` : ""}`);
			const body = (await response.json()) as {
				path?: string;
				parent?: string | null;
				entries?: DirEntry[];
				error?: { message?: string };
			};
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
		newChat(target);
		onClose();
	};

	return (
		<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="新建项目">
			<div className="modal new-project">
				<div className="new-project-head">
					<strong>🗂 本地目录</strong>
					<span className="topbar-spacer" />
					<button type="button" className="btn btn-tiny" onClick={onClose} title="关闭">
						✕
					</button>
				</div>

				<div className="new-project-bar">
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => void load(parent ?? undefined)}
						disabled={!parent || loading}
					>
						↑ 上级目录
					</button>
					<input
						className="new-project-input mono"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void load(input.trim());
						}}
						placeholder="/绝对路径"
					/>
					<button type="button" className="btn btn-tiny" onClick={() => void load(input.trim())} disabled={loading}>
						跳转
					</button>
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
					{loading ? <div className="side-panel-hint">读取中…</div> : null}
					{!loading && entries.length === 0 ? <div className="side-panel-hint">这个目录下没有子目录</div> : null}
					{entries.map((entry) => (
						<div className="new-project-row" key={entry.path}>
							<button
								type="button"
								className="new-project-name"
								onClick={() => void load(entry.path)}
								title={entry.path}
							>
								📁 {entry.name}
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
