import type { ChangedFile } from "../changed-files.ts";
import { useT } from "../use-language.ts";

/**
 * 「这一轮改动的文件」那一排 chip，挂在助手消息尾注**上方**。
 *
 * 为什么放在那儿：它是这一轮的**结果**，跟 tail 上的 token 用量 / 时间同一类东西，
 * 所以贴着尾注；但点在它上面会开右侧面板，属于「还能继续操作」的东西，因此在正文之后、
 * 尾注之前 —— 放在尾注后面会被时间戳和复制按钮隔开，看起来像条脚注。
 *
 * 点一下 = 在右侧按文件管理的方式打开预览（跟左侧文件树点文件同一个动作）：
 * 省掉「去左边找文件 → 展开目录 → 找到它」的往返。
 */

/** 徽标分组：只分三档，够区分「代码 / 样式 / 文本」，不引新色板 */
function kindOf(ext: string): "code" | "style" | "text" {
	if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "rb", "php", "sh"].includes(ext))
		return "code";
	if (["css", "scss", "sass", "less", "html", "vue", "svelte"].includes(ext)) return "style";
	return "text";
}

/** 徽标上的字：太长的扩展名截成 3 个字，没扩展名就写「文件」 */
function badgeOf(ext: string): string {
	if (ext === "") return "文件";
	return ext.length <= 4 ? ext.toUpperCase() : ext.slice(0, 3).toUpperCase();
}

export function ChangedFiles({ files, onOpen }: { files: ChangedFile[]; onOpen?: (file: ChangedFile) => void }) {
	const t = useT();
	if (files.length === 0) return null;
	return (
		<div className="msg-files">
			<span className="msg-files-label" title={t("这一轮工具写过的文件（按第一次出现的顺序）")}>
				改动 {files.length} 个文件
			</span>
			{files.map((file) => (
				<button
					type="button"
					key={file.path}
					className={`msg-file${file.outside ? " msg-file-off" : ""}`}
					disabled={file.outside || !onOpen}
					title={file.outside ? `${file.path}（在工作区之外，右侧预览读不了）` : `${file.path} · 点一下在右侧打开`}
					onClick={() => onOpen?.(file)}
				>
					<span className={`msg-file-badge msg-file-badge-${kindOf(file.ext)}`}>{badgeOf(file.ext)}</span>
					<span className="msg-file-name">{file.name}</span>
				</button>
			))}
		</div>
	);
}
