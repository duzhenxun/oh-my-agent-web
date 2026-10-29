/**
 * 「当前项目在哪个 git 分支」+「有哪些本地分支」—— 文件管理区下拉框右边那枚分支小标签用它。
 *
 * 跟着 root 走；不是 git 仓库就不显示（isRepo=false）。
 * 标签点开是分支菜单：`checkout(name)` 切分支，成功后把服务端返回的最新状态直接吃掉
 * （不再多跑一次 GET）；失败返回一句人话错误，菜单里显示、不关。
 */
import { useCallback, useEffect, useState } from "react";

type GitBranch = {
	isRepo: boolean;
	branch: string | null;
	/** 本地分支名（最近提交的排前面）；不是仓库 / 没装 git 时是空数组 */
	branches: string[];
	/** 列不出分支的原因（例如机器上没装 git）：界面照常显示当前分支，只禁用下拉 */
	error?: string;
};

/** 切分支的结果：`dirty` 有值 = 服务端没切，在等界面确认 */
type CheckoutOutcome = { ok: true } | { ok: false; message: string; dirty?: { files: string[]; total: number } };

const EMPTY: GitBranch = { isRepo: false, branch: null, branches: [] };

export function useGitBranch(root: string | null): GitBranch & {
	/** 重新拉一次（打开分支菜单时用：别的终端里刚建的分支也能看见） */
	refresh: () => void;
	/** 切分支：成功 `{ ok: true }`；工作区脏时带 `dirty` 回来等确认（`force` 才真切） */
	checkout: (name: string, options?: { force?: boolean }) => Promise<CheckoutOutcome>;
} {
	const [state, setState] = useState<GitBranch>(EMPTY);
	const [version, setVersion] = useState(0);

	useEffect(() => {
		setState(EMPTY);
		if (!root) return;
		let cancelled = false;
		void (async () => {
			try {
				const response = await fetch(`/api/files/git?root=${encodeURIComponent(root)}`);
				const body = (await response.json()) as Partial<GitBranch>;
				if (cancelled) return;
				setState({
					isRepo: body.isRepo === true,
					branch: body.branch ?? null,
					branches: Array.isArray(body.branches) ? body.branches : [],
					error: typeof body.error === "string" ? body.error : undefined,
				});
			} catch {
				// 拿不到就当不是仓库（不显示分支）
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [root, version]);

	const refresh = useCallback(() => setVersion((value) => value + 1), []);

	const checkout = useCallback(
		async (name: string, options: { force?: boolean } = {}): Promise<CheckoutOutcome> => {
			if (!root) return { ok: false, message: "还没有打开项目" };
			try {
				const response = await fetch("/api/files/git/checkout", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ root, branch: name, force: options.force === true }),
				});
				const body = (await response.json()) as Partial<GitBranch> & {
					error?: { code?: string; message?: string; files?: unknown; total?: unknown };
				};
				if (!response.ok || body.error) {
					if (body.error?.code === "files.dirty_worktree") {
						return {
							ok: false,
							message: body.error.message ?? "工作区有未提交改动",
							dirty: {
								files: Array.isArray(body.error.files)
									? body.error.files.filter((f): f is string => typeof f === "string")
									: [],
								total: typeof body.error.total === "number" ? body.error.total : 0,
							},
						};
					}
					return { ok: false, message: body.error?.message ?? `切换到 ${name} 失败` };
				}
				setState({
					isRepo: body.isRepo === true,
					branch: body.branch ?? name,
					branches: Array.isArray(body.branches) ? body.branches : [],
					error: undefined,
				});
				return { ok: true };
			} catch {
				return { ok: false, message: "切分支的请求没发出去（服务端没响应）" };
			}
		},
		[root],
	);

	return { ...state, refresh, checkout };
}

/** 分支标签 / 分支菜单用的那份状态（含 refresh / checkout） */
export type GitBranchControl = ReturnType<typeof useGitBranch>;
