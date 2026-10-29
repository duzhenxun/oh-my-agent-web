/**
 * 分支菜单：「⎇ feature/wo…」点开后的下拉列表 —— 点一项就 `git checkout` 过去。
 *
 * 复用项目菜单那套浮窗（portal + fixed，SidebarFiles 是滚动容器，内联菜单会被裁掉）。
 * 工作区有未提交改动时先在这里拦一下：列几个文件名 + 「仍然切换 / 取消」，
 * 确认才带 `force` 真切。失败**不关菜单**：git 的报错就显示在列表下面
 * （「本地改动会被覆盖」这种要能看见），换个分支再点一次就行。
 */
import { useState } from "react";
import { ProjectMenuPopover } from "./ProjectMenuPopover.tsx";
import type { GitBranchControl } from "../use-git-branch.ts";
import { useT } from "../use-language.ts";

/** 等确认的那一次切换（工作区脏时） */
type Confirm = { name: string; files: string[]; total: number };

export function GitBranchMenu({
	anchor,
	git,
	align,
	onClose,
}: {
	/** 那枚分支标签（菜单贴着它右下弹） */
	anchor: HTMLElement;
	git: GitBranchControl;
	/** 水平对齐：新会话那一行用 `center`（跟上边那颗项目下拉框对齐一致），文件区默认贴右边 */
	align?: "end" | "center";
	onClose: () => void;
}) {
	const t = useT();
	/** 正在切的分支名（按钮暂时全部禁用，避免连点切两次） */
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<Confirm | null>(null);

	const pick = async (name: string, force = false) => {
		if (pending || name === git.branch) return;
		setPending(name);
		setError(null);
		const outcome = await git.checkout(name, { force });
		setPending(null);
		if (outcome.ok) {
			onClose();
			return;
		}
		// 工作区脏：不报错，换成「确认」面板
		if (outcome.dirty) setConfirm({ name, files: outcome.dirty.files, total: outcome.dirty.total });
		else setError(outcome.message);
	};

	return (
		<ProjectMenuPopover anchor={anchor} className="proj-menu files-branch-menu" align={align} onClose={onClose}>
			<div className="files-branch-menu-head">
				<span className="files-branch-menu-title">{confirm ? "确认切换分支" : "切换分支"}</span>
				<button
					type="button"
					className="files-branch-refresh"
					title={t("刷新分支列表（别的终端里刚建的分支）")}
					onClick={() => {
						setError(null);
						setConfirm(null);
						git.refresh();
					}}
				>
					⟳
				</button>
			</div>
			{confirm ? (
				<div className="files-branch-confirm">
					<div className="files-branch-confirm-text">
						⚠️ 工作区有 <b>{confirm.total}</b> {t("个未提交改动。切到")} <b>{confirm.name}</b> 会把它们带过去 （git
						不会丢弃，放不下的会拒绝切换）。
					</div>
					{confirm.files.length > 0 ? (
						<ul className="files-branch-confirm-files">
							{confirm.files.slice(0, 5).map((file) => (
								<li key={file} title={file}>
									{file}
								</li>
							))}
							{confirm.total > 5 ? (
								<li className="files-branch-confirm-more">
									… {t("还有", "and")} {confirm.total - 5} {t("个", "more")}
								</li>
							) : null}
						</ul>
					) : null}
					<div className="files-branch-confirm-actions">
						<button
							type="button"
							className="files-branch-btn files-branch-btn-primary"
							disabled={pending !== null}
							onClick={() => void pick(confirm.name, true)}
						>
							{pending === confirm.name ? "切换中…" : "仍然切换"}
						</button>
						<button
							type="button"
							className="files-branch-btn"
							disabled={pending !== null}
							onClick={() => setConfirm(null)}
						>
							取消
						</button>
					</div>
				</div>
			) : git.branches.length === 0 ? (
				<div className="files-branch-hint">{git.error ?? "这个仓库还没有别的分支"}</div>
			) : (
				<div className="files-branch-list">
					{git.branches.map((name) => {
						const current = name === git.branch;
						return (
							<button
								type="button"
								key={name}
								role="menuitemradio"
								aria-checked={current}
								className={`proj-menu-item files-branch-item${current ? " files-branch-item-current" : ""}`}
								title={current ? `${name}（当前分支）` : `切换到 ${name}`}
								disabled={pending !== null}
								onClick={() => void pick(name)}
							>
								<span className="files-branch-tick">{current ? "✓" : ""}</span>
								<span className="files-branch-item-name">{name}</span>
								{pending === name ? <span className="files-branch-pending">{t("切换中…")}</span> : null}
							</button>
						);
					})}
				</div>
			)}
			{error ? <div className="files-branch-error">{error}</div> : null}
		</ProjectMenuPopover>
	);
}
