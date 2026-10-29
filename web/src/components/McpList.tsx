import { serverKey, type Scope, type Server } from "../mcp-view.ts";
import { useT } from "../use-language.ts";

/**
 * MCP 面板的**左栏**：分组的服务器列表 + 底部两个入口（添加 / 市场）。
 *
 * 从 `McpPanel.tsx` 拆出来（400 行护栏）：这一栏的职责很窄 —— 回答「有哪些服务器、开没开」，
 * 并把「选中哪台 / 要不要切换右栏」这两件事报给面板。右栏那三种内容与它无关。
 */

type McpPaneKind = "detail" | "add" | "market";

export function McpList({
	servers,
	projectPath,
	globalPath,
	selected,
	pane,
	busy,
	onSelect,
	onToggleScope,
	onPane,
}: {
	servers: Server[];
	projectPath: string;
	globalPath: string;
	/** 当前选中的服务器 key（`scope:name`） */
	selected: string | null;
	/** 右栏现在显示什么（决定底部两个按钮的高亮） */
	pane: McpPaneKind;
	busy: boolean;
	onSelect: (key: string) => void;
	/** 整组开 / 关（`enabled` 是目标状态） */
	onToggleScope: (scope: Scope, enabled: boolean) => void;
	onPane: (kind: McpPaneKind) => void;
}) {
	const t = useT();
	const groups: { scope: Scope; label: string; path: string; items: Server[] }[] = [
		{
			scope: "project",
			label: t("项目", "Project"),
			path: projectPath,
			items: servers.filter((server) => server.scope === "project"),
		},
		{
			scope: "global",
			label: t("全局", "Global"),
			path: globalPath,
			items: servers.filter((server) => server.scope === "global"),
		},
	];

	return (
		<div className="mcp-list">
			<div className="mcp-list-scroll">
				{groups.map((group) => (
					<div className="mcp-group" key={group.scope}>
						<div className="mcp-group-head">
							<span>{group.label}</span>
							<span className="side-panel-count">
								{group.items.filter((server) => server.enabled).length}/{group.items.length}
							</span>
							<button
								type="button"
								role="switch"
								aria-checked={group.items.length > 0 && group.items.every((server) => server.enabled)}
								aria-label={t(
									`${group.label}的服务器全部${group.items.every((server) => server.enabled) ? "停用" : "启用"}`,
									`${group.items.every((server) => server.enabled) ? "Disable" : "Enable"} every server in ${group.label}`,
								)}
								className={`mcp-switch${group.items.some((server) => server.enabled) ? " mcp-switch-on" : ""}`}
								disabled={group.items.length === 0 || busy}
								title={`${group.label}这一份配置里的服务器一起开 / 关`}
								onClick={() => onToggleScope(group.scope, !group.items.every((server) => server.enabled))}
							>
								{/* 文案写的是**下一步做什么**，不是当前状态（状态由左边的 n/N 和每个点的颜色回答） */}
								{group.items.every((server) => server.enabled) ? t("全关", "All off") : t("全开", "All on")}
							</button>
						</div>
						{group.items.length === 0 ? (
							<div className="side-panel-count">
								{group.scope === "project"
									? t("这个项目没有自己的 MCP", "This project has no MCP servers of its own")
									: t("还没有 MCP 服务器", "No MCP servers yet")}
							</div>
						) : (
							group.items.map((server) => (
								<button
									type="button"
									key={serverKey(server)}
									className={`mcp-item${selected === serverKey(server) ? " mcp-item-on" : ""}${server.enabled ? "" : " mcp-item-off"}`}
									onClick={() => onSelect(serverKey(server))}
									title={server.description ?? server.name}
								>
									<span className={`mcp-dot${server.enabled ? " mcp-dot-on" : ""}`} aria-hidden="true" />
									<span className="mcp-item-name">{server.name}</span>
								</button>
							))
						)}
						{group.items.length > 0 && group.path ? (
							<span className="mcp-list-path mono" title={group.path}>
								{group.path}
							</span>
						) : null}
					</div>
				))}
			</div>

			{/* 添加 / 市场：都放右栏（左栏放不下一条 npx 命令），这里只留两个入口 */}
			<div className="mcp-left-actions">
				<button
					type="button"
					className={`btn btn-tiny${pane === "add" ? " btn-on" : ""}`}
					onClick={() => onPane("add")}
				>
					＋ {t("添加 MCP", "Add MCP")}
				</button>
				<button
					type="button"
					className={`btn btn-tiny${pane === "market" ? " btn-on" : ""}`}
					onClick={() => onPane("market")}
					title={t("从公开注册中心一键添加", "Add from the public registry in one click")}
				>
					{t("市场", "Market")}
				</button>
			</div>
		</div>
	);
}
