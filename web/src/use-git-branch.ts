/**
 * 「当前项目在哪个 git 分支」—— 文件管理区下拉框右边那枚分支小标签用它。
 *
 * 跟着 root 走；不是 git 仓库就不显示（isRepo=false）。
 */
import { useEffect, useState } from "react";

export type GitBranch = { isRepo: boolean; branch: string | null };

export function useGitBranch(root: string | null): GitBranch {
	const [state, setState] = useState<GitBranch>({ isRepo: false, branch: null });

	useEffect(() => {
		setState({ isRepo: false, branch: null });
		if (!root) return;
		let cancelled = false;
		void (async () => {
			try {
				const response = await fetch(`/api/files/git?root=${encodeURIComponent(root)}`);
				const body = (await response.json()) as { isRepo?: boolean; branch?: string | null };
				if (cancelled) return;
				setState({ isRepo: body.isRepo === true, branch: body.branch ?? null });
			} catch {
				// 拿不到就当不是仓库（不显示分支）
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [root]);

	return state;
}
