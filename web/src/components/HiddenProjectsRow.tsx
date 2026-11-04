/**
 * 「已隐藏 · N」—— 侧栏列表里的**二级入口**（跟「已归档 · N」同一层同一套观感）。
 *
 * 它现在只管「这一整块收着还是展开着」：展开之后，被隐藏的项目就是普通的项目行
 * （文件夹 + 名字 + 右键菜单，点开还能看见里面的会话），只是画在这个入口下面。
 * 也就是说隐藏区跟项目管理那一栏是同一套东西 —— 用户 2026-11-03：
 * 「已隐藏里面也要分项目、项目也能点开、里面的会话也能点，功能跟项目管理低一级的一样，
 *  相当于把它放进一个二级文件夹里」。
 *
 * 所以这里**不再列项目名、也不再有一排「取消隐藏」按钮**：
 * 取消隐藏走那个项目自己的右键菜单（项目菜单最后一项），跟「隐藏项目」同一个位置。
 */
import { useT } from "../use-language.ts";

export function HiddenProjectsRow({
	count,
	open,
	onToggle,
}: {
	/** 藏了几个项目（0 时整行不画，调用方也会直接不渲染） */
	count: number;
	/** 这一块展开着没有 */
	open: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	if (count <= 0) return null;
	return (
		<button
			type="button"
			className="archived-row-entry hidden-row-entry"
			title={
				open
					? t("收起隐藏的项目", "Collapse hidden projects")
					: t(
							`已隐藏 ${count} 个项目（点一下展开，里面跟项目管理一样能点开项目、打开会话）`,
							`${count} hidden project(s) — click to expand; projects and sessions work like the main list`,
						)
			}
			aria-expanded={open}
			onClick={onToggle}
		>
			<span className="proj-chevron" aria-hidden="true">
				🙈
			</span>
			<span className="hidden-row-name">
				{t("已隐藏", "Hidden")} · {count}
			</span>
		</button>
	);
}
