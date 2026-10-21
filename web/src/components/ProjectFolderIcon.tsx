/**
 * 项目行前面的小图标：**收起 = 合着的文件夹，展开 = 打开的文件夹**。
 *
 * 以前是个旋转的小箭头，信息量低；文件夹的合/开更直观，也贴合「项目 = 目录」这件事。
 * 两枚图标用同一套 24 格线条（stroke 1.8），16px 下轮廓清楚、彼此区分明显。
 */
const STROKE = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.8,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

export function ProjectFolderIcon({ open }: { open: boolean }) {
	return (
		<span className={`proj-chevron${open ? " proj-chevron-open" : ""}`} aria-hidden="true">
			{open ? (
				<svg viewBox="0 0 24 24" className="proj-folder">
					{/* 打开的文件夹（lucide folder-open） */}
					<path
						d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
						{...STROKE}
					/>
				</svg>
			) : (
				<svg viewBox="0 0 24 24" className="proj-folder">
					{/* 合着的文件夹（lucide folder） */}
					<path
						d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
						{...STROKE}
					/>
				</svg>
			)}
		</span>
	);
}
