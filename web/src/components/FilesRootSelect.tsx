/**
 * 文件区上方那个「项目下拉框」—— 自绘，不用原生 `<select>`。
 *
 * 为什么不用 `<select>`：**展开后的列表是操作系统画的**，完全不受 CSS 控制
 * （macOS 上就是一块浅灰圆角菜单，跟任何皮肤都不搭）。原生 `<select>` 只能美化合着的那一条，
 * 一旦点开立刻穿帮，所以这里用「按钮 + 浮层」自己画：
 *   - 合着的样子沿用原来那条（同样的边框/圆角/字号），只是箭头换成细描边 SVG；
 *   - 展开的列表复用项目菜单的浮层（portal + fixed + 贴边翻转 + 点外面/Esc 关），
 *     每一项都是普通按钮，颜色全部走主题变量，六套皮肤自动跟着变。
 */
import { useState } from "react";
import { basename } from "../path-utils.ts";
import { ProjectMenuPopover } from "./ProjectMenuPopover.tsx";

type RootOption = { cwd: string; label: string };

export function FilesRootSelect({
	value,
	options,
	onChange,
}: {
	/** 当前选中的 root（空串 = 跟随当前会话） */
	value: string;
	options: RootOption[];
	onChange: (cwd: string | null) => void;
}) {
	const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const current = options.find((option) => option.cwd === value);
	const label = current?.label ?? (value === "" ? "跟随当前会话" : basename(value) || value);

	const pick = (cwd: string | null) => {
		onChange(cwd);
		setOpen(false);
	};

	return (
		<>
			<button
				type="button"
				ref={setAnchor}
				className={`side-files-root${open ? " side-files-root-open" : ""}`}
				title={value === "" ? "文件树跟着当前会话走（点一下可换项目）" : `文件树根目录：${value}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen((state) => !state)}
			>
				<span className="side-files-root-label">{label}</span>
				{/* 细描边小三角：跟标题栏那排图标同一套线宽，比原生的实心箭头轻 */}
				<svg viewBox="0 0 16 16" className="side-files-root-caret" aria-hidden="true">
					<path d="m4.4 6.4 3.6 3.6 3.6-3.6" />
				</svg>
			</button>
			{open && anchor ? (
				<ProjectMenuPopover
					anchor={anchor}
					className="proj-menu files-root-menu"
					/* 列表宽度跟着按钮走（200–320）：比固定 260px 更像「这个按钮展开出来的」 */
					style={{ width: Math.min(320, Math.max(200, anchor.getBoundingClientRect().width)) }}
					onClose={() => setOpen(false)}
				>
					<button
						type="button"
						className={`proj-menu-item files-root-option${value === "" ? " files-root-option-on" : ""}`}
						onClick={() => pick(null)}
					>
						<span className="files-root-check" aria-hidden="true">
							{value === "" ? "✓" : ""}
						</span>
						跟随当前会话
					</button>
					{options.length > 0 ? <div className="files-root-sep" /> : null}
					{options.map((option) => (
						<button
							type="button"
							key={option.cwd}
							className={`proj-menu-item files-root-option${value === option.cwd ? " files-root-option-on" : ""}`}
							title={option.cwd}
							onClick={() => pick(option.cwd)}
						>
							<span className="files-root-check" aria-hidden="true">
								{value === option.cwd ? "✓" : ""}
							</span>
							<span className="files-root-option-label">{option.label}</span>
						</button>
					))}
				</ProjectMenuPopover>
			) : null}
		</>
	);
}
