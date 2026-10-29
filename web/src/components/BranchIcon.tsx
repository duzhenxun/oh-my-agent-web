/**
 * 分支图标（16 格：两个圆点 + 一条曲线）。
 *
 * 为什么单独一个组件：输入框上方那排的「项目 · 分支」有两处要用 ——
 * 新会话的项目下拉里那颗（`NewSessionScope`）和已建会话常驻的分支胶囊
 * （`ProjectBranchChips`）。线条必须一模一样，否则同一排里两颗图标粗细微妙地不同。
 */
export function BranchIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="4.6" cy="3.6" r="1.7" />
			<circle cx="4.6" cy="12.4" r="1.7" />
			<circle cx="11.4" cy="6.4" r="1.7" />
			<path d="M4.6 5.3v5.4" />
			<path d="M11.4 8.1c0 2.2-3.1 1.9-5.1 2.9" />
		</svg>
	);
}
