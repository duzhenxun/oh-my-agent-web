/**
 * 面板图标（16 格线性小图标）：顶栏按钮、弹窗 tab、设置里的「顶栏」勾选框共用一套。
 *
 * 独立成文件是为了避开循环依赖：SidebarMenu 引 SettingsPanel，SettingsPanel 又要用它。
 */
export type PanelIconName = "models" | "skills" | "push" | "voice" | "plugins" | "mcp" | "agents" | "settings";

/**
 * 一套线性小图标（16 格），替掉原来的大彩 emoji：
 * emoji 在不同系统上大小/风格都不一样（有的还特别大），一排放在顶栏很难看。
 */
export function PanelIcon({ name }: { name: PanelIconName }) {
	const common = {
		viewBox: "0 0 16 16",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.3,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
		"aria-hidden": true,
	};
	if (name === "models")
		return (
			<svg {...common}>
				<rect x="2.8" y="5.4" width="10.4" height="7.6" rx="2.2" />
				<path d="M8 5.4V3.4" />
				<circle cx="8" cy="2.6" r="0.85" fill="currentColor" stroke="none" />
				<circle cx="6" cy="9.2" r="0.8" fill="currentColor" stroke="none" />
				<circle cx="10" cy="9.2" r="0.8" fill="currentColor" stroke="none" />
			</svg>
		);
	if (name === "skills")
		return (
			<svg {...common}>
				<rect x="2.2" y="5.9" width="11.6" height="7.4" rx="1.7" />
				<path d="M6.1 5.9V4.3c0-.6.5-1.1 1.1-1.1h1.6c.6 0 1.1.5 1.1 1.1v1.6" />
				<path d="M2.2 9.3h11.6" />
			</svg>
		);
	if (name === "push")
		return (
			<svg {...common}>
				<path d="M4.3 11.1V7.7a3.7 3.7 0 1 1 7.4 0v3.4l1.1 1.5H3.2l1.1-1.5Z" />
				<path d="M6.5 14.1a1.6 1.6 0 0 0 3 0" />
			</svg>
		);
	if (name === "plugins")
		return (
			<svg {...common}>
				{/* 插头：一块方头 + 两根针脚，跟其它线性图标同一套描边 */}
				<rect x="4.2" y="6.6" width="7.6" height="6.2" rx="1.6" />
				<path d="M6.2 6.6V3.9M9.8 6.6V3.9" />
				<path d="M8 12.8v1.6" />
			</svg>
		);
	if (name === "voice")
		return (
			<svg {...common}>
				{/* 话筒 + 两道声波：跟其它线性图标同一套描边 */}
				<rect x="6.2" y="2.2" width="3.6" height="6.6" rx="1.8" />
				<path d="M4.4 8.2a3.6 3.6 0 0 0 7.2 0" />
				<path d="M8 11.8v2" />
				<path d="M12.6 4.2a4.4 4.4 0 0 1 0 4.6M3.4 4.2a4.4 4.4 0 0 0 0 4.6" />
			</svg>
		);
	if (name === "agents")
		return (
			<svg {...common}>
				{/* 机器人头 + 天线：子代理是「另一个在干活的小 agent」 */}
				<rect x="3.2" y="5.6" width="9.6" height="7.4" rx="2.2" />
				<path d="M8 5.6V3.3" />
				<circle cx="8" cy="2.5" r="0.8" fill="currentColor" stroke="none" />
				<circle cx="6" cy="8.6" r="0.7" fill="currentColor" stroke="none" />
				<circle cx="10" cy="8.6" r="0.7" fill="currentColor" stroke="none" />
				<path d="M6.2 10.9h3.6" />
			</svg>
		);
	if (name === "mcp")
		return (
			<svg {...common}>
				{/* 机架：两层「服务器」+ 右側連出去的一根线，表示「给模型供工具的服务器」 */}
				<rect x="1.9" y="3.2" width="8.6" height="3.9" rx="1.1" />
				<rect x="1.9" y="8.9" width="8.6" height="3.9" rx="1.1" />
				<circle cx="4" cy="5.15" r="0.6" fill="currentColor" stroke="none" />
				<circle cx="4" cy="10.85" r="0.6" fill="currentColor" stroke="none" />
				<path d="M10.5 5.15h1.4a1.2 1.2 0 0 1 1.2 1.2v3.3a1.2 1.2 0 0 0 1.2 1.2H15" />
			</svg>
		);
	return (
		<svg {...common}>
			<path d="M2.6 5.4h10.8M2.6 10.6h10.8" />
			<circle cx="6" cy="5.4" r="1.7" fill="var(--bg-elev)" />
			<circle cx="10.2" cy="10.6" r="1.7" fill="var(--bg-elev)" />
		</svg>
	);
}
