import { useState } from "react";
import { basename } from "../path-utils.ts";
import { useGitBranch } from "../use-git-branch.ts";
import { BranchIcon } from "./BranchIcon.tsx";
import { FolderIcon } from "./FolderIcon.tsx";
import { GitBranchMenu } from "./GitBranchMenu.tsx";
import { useT } from "../use-language.ts";

/**
 * 「当前项目 · 分支」两颗 —— 输入框上方那一排，排在**模型左边**（用户 2026-10-29 定）。
 *
 * 以前「我在哪个项目里」只写在底部状态栏；现在挪到这儿，跟「模型 / 强度 / 模板」同一排：
 * 项目 + 分支本来就是「这一句落在哪个仓库、哪条线上」的上下文，跟模型那几颗一类，
 * 眼睛扫一排就能确认，不用往下看到状态栏。
 *
 * 规矩（都来自需求本身）：
 *  1. 项目那颗**只是显示**：会话一旦建好，它就归属那个目录了 —— 这里给不了「换项目」
 *     （换项目 = 另起一条新会话，见 `NewSessionScope`），所以它不可点，只给完整路径的 tooltip。
 *  2. 分支那颗**只对 git 仓库画**：不是仓库 / 拿不到分支就整颗不出现（留一颗「branch: 无」
 *     既占地方又让人以为能点）。点开的是文件区那枚分支标签**同一张菜单**（`GitBranchMenu`）：
 *     选一项就真的 `git checkout`，工作区脏时先拦一次再确认。
 *  3. 手机上不画：那一排本来就窄（型号 / 模板 / 想想都挤在一起，强度那颗都被 CSS 收起来了），
 *     项目名仍留在底部状态栏（用户要求「手机版保持原样」）。
 *
 * 新会话（还没建）时也不画：那一刻 `NewSessionScope` 已经在同一位置画了「项目 ▾ · 分支 ▾」，
 * 那是**可选的**（选完才建会话），跟这里「已定的项目」不是一回事，两颗并排会让人分不清哪个算数。
 */
export function ProjectBranchChips({ projectRoot }: { projectRoot: string }) {
	const t = useT();
	const git = useGitBranch(projectRoot);
	const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const name = basename(projectRoot) || projectRoot;
	return (
		<>
			{/* 项目：静态标签，不可点（见上面第 1 条）。tooltip 给完整路径，同名目录能分清 */}
			<span className="new-scope-chip new-scope-chip-static" title={projectRoot}>
				<span className="new-scope-icon" aria-hidden="true">
					<FolderIcon open={false} />
				</span>
				<span className="new-scope-label">{name}</span>
			</span>
			{git.isRepo && git.branch ? (
				<button
					type="button"
					ref={setAnchor}
					className="new-scope-chip"
					title={t(`当前分支：${git.branch}（点一下切换）`, `Current branch: ${git.branch} (click to switch)`)}
					aria-haspopup="menu"
					aria-expanded={open}
					onClick={() => {
						// 每次打开都刷一下：别的终端里刚 checkout / 刚建的分支也能看见
						if (!open) git.refresh();
						setOpen((value) => !value);
					}}
				>
					<BranchIcon className="new-scope-icon new-scope-branch-icon" />
					<span className="new-scope-label">{git.branch}</span>
				</button>
			) : null}
			{open && anchor ? (
				<GitBranchMenu anchor={anchor} git={git} align="center" onClose={() => setOpen(false)} />
			) : null}
		</>
	);
}
