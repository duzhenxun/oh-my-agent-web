import { useMemo } from "react";
import { parseDiff, type FileDiffPayload } from "../file-diff.ts";
import { useT } from "../use-language.ts";

/**
 * 「这个文件改了什么」：git diff 的 +/- 视图。
 *
 * 只负责画：数据由外壳（FilePreview 的 FileViewer）取好传进来 ——
 * 那边的头部要用 added/removed 决定「改动」页签显不显示，取两次等于多起一个 git 进程。
 */
export function FileDiff({ payload }: { payload: FileDiffPayload }) {
	const t = useT();
	const rows = useMemo(() => parseDiff(payload.diff), [payload.diff]);

	if (payload.error) return <div className="file-preview-error">{payload.error}</div>;
	if (payload.diff.trim() === "") {
		return (
			<div className="file-diff-empty">
				{payload.isRepo
					? t("这个文件相对上次提交没有改动", "This file has no changes since the last commit")
					: t("这里不是 git 仓库，看不到改动", "Not a git repository — no diff available")}
			</div>
		);
	}
	return (
		<div className="file-diff">
			<div className="file-diff-summary">
				<span className="file-diff-added mono">+{payload.added}</span>
				<span className="file-diff-removed mono">−{payload.removed}</span>
				<span className="file-diff-base">
					{payload.untracked
						? t("新文件（整份都是新增）", "New file (everything is added)")
						: t("对照上次提交（HEAD），含已暂存", "Against the last commit (HEAD), including staged changes")}
				</span>
			</div>
			<pre className="file-diff-body mono">
				{rows.map((row, index) => {
					// 文件头那四行（diff --git / index / --- / +++）在这里全是冗余：面板标题已经是这个文件名了
					if (row.kind === "meta" && /^(diff --git |index |--- |\+\+\+ |new file mode )/.test(row.text)) return null;
					if (row.kind === "hunk") {
						return (
							<div className="diff-line diff-line-hunk" key={index}>
								<span className="diff-no diff-no-empty" />
								<span className="diff-no diff-no-empty" />
								<span className="diff-sign" />
								<span className="diff-text">{row.text}</span>
							</div>
						);
					}
					if (row.kind === "meta" || row.kind === "note") {
						return (
							<div className={`diff-line diff-line-${row.kind}`} key={index}>
								<span className="diff-no diff-no-empty" />
								<span className="diff-no diff-no-empty" />
								<span className="diff-sign" />
								<span className="diff-text">{row.text}</span>
							</div>
						);
					}
					const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
					return (
						<div className={`diff-line diff-line-${row.kind}`} key={index}>
							{/* 新旧两列行号：删行只占旧列、加行只占新列 —— 跟 git 一样，一眼看出是对哪一行动的手 */}
							<span className="diff-no">{row.kind === "add" ? "" : row.oldNo}</span>
							<span className="diff-no">{row.kind === "del" ? "" : row.newNo}</span>
							<span className="diff-sign">{sign}</span>
							<span className="diff-text">{row.text || " "}</span>
						</div>
					);
				})}
			</pre>
			{payload.truncated ? (
				<div className="file-diff-note">
					{t("改动太长，只显示前一部分", "The diff is long — only the first part is shown")}
				</div>
			) : null}
		</div>
	);
}
