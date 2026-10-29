/**
 * 文件夹图标：**收起 = 合着的文件夹，展开 = 打开的文件夹**（lucide 的 folder / folder-open）。
 *
 * 为什么统一成一个组件：项目行、文件树两处都要用，之前文件树用的是 📂/📁 emoji ——
 * emoji 在不同系统上大小、配色都不一样，跟旁边那条细描边的类型小标摆在一起很出戏。
 * 现在两处共用这一份路径与描边（24 格 / stroke 1.8），缩到 13–16px 也清楚。
 */
const STROKE = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.8,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

/** 打开的文件夹（lucide folder-open） */
const FOLDER_OPEN =
	"m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2";

/** 合着的文件夹（lucide folder） */
const FOLDER =
	"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";

export function FolderIcon({ open, className }: { open: boolean; className?: string }) {
	return (
		<svg viewBox="0 0 24 24" className={className} aria-hidden="true">
			<path d={open ? FOLDER_OPEN : FOLDER} {...STROKE} />
		</svg>
	);
}

/** 合着的文件夹 + 中间一个加号：「新建项目」用的那枚（lucide folder-plus 的画法） */
export function FolderPlusIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" className={className} aria-hidden="true">
			<path d="M12 10v6" {...STROKE} />
			<path d="M9 13h6" {...STROKE} />
			<path d={FOLDER} {...STROKE} />
		</svg>
	);
}
