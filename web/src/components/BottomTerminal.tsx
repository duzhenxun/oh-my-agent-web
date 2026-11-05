import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../use-language.ts";
import { useStoredNumber } from "../use-stored-number.ts";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { PanelIcon } from "./PanelIcon.tsx";

/**
 * 底部终端（VSCode 那种）：挂在对话框**下面**，一排标签 + 可拖高 + 分屏。
 *
 * 结构：
 *   - 标签栏每一个标签 = 一个**分组**；
 *   - 分组里目前只有一个终端（`panes` 结构保留，便于以后再加分屏）。
 *
 * 跟右侧面板里的终端（`PreviewPanel` 的 `kind: "terminal"`）是两码事：
 *   - 那边是「工具标签」，跟文件 / 网页并排；
 *   - 这边常驻在对话底下，边聊边敲命令，两边互不影响。
 *
 * 生命周期（和 VSCode 一致）：
 *   - **隐藏**（⌄ / ⌃`）只是藏起来，shell 继续跑，历史不丢；
 *   - **关掉分组**（标签上的 ×）或最后一个分屏，才真杀进程（`TerminalPanel` 卸载时 stop）；
 *   - 关光最后一个分组 = 收起，下次打开自动新开一个。
 *
 * 每个终端的 cwd 在**创建时**定死：切会话 / 换工作区不会把正在跑的 shell 重启。
 */

const HEIGHT_KEY = "agent-web.bottom-term.height";
const HEIGHT_DEFAULT = 240;
const HEIGHT_MIN = 120;
const HEIGHT_MAX = 900;
/** 拖高时的上限：不超过窗口高度的这个比例，免得把对话区整个挤没 */
const HEIGHT_VIEWPORT_RATIO = 0.7;

interface Pane {
	/** 也是服务端 PTY 的 id */
	id: string;
	cwd: string | null;
	/** 建好 PTY 后自动敲进去的命令（「↑ 有新版」→ 安装走这里）；null = 普通终端 */
	initialCommand: string | null;
}

interface Group {
	id: string;
	panes: Pane[];
	/** 当前有焦点的那一屏（键盘输入、refit 都落在它身上） */
	activePaneId: string;
}

/** id 的自增序号：模块级即可（同一页里只有一套底部终端） */
let idSeq = 0;
function nextId(prefix: string): string {
	idSeq += 1;
	return `${prefix}:${idSeq}`;
}

export function BottomTerminal({
	open,
	cwd,
	onHide,
	request = null,
	onOpenSettings,
}: {
	/** 是否显示（收起时仍挂着，shell 不断） */
	open: boolean;
	/**
	 * 条尾巴上那颗「设置」：打开工作台的设置面板（和顶栏那颗同一个面板）。
	 * 不传就不画 —— 换到别的宿主（单测、嵌入）时不该凭空多一颗点不动的按钮。
	 */
	onOpenSettings?: () => void;
	/** 新分组的起始目录：当前会话工作区 */
	cwd: string | null;
	/** 点 ⌄ 或最后一个分组被关掉：收起整条 */
	onHide: () => void;
	/**
	 * 「在某个目录里打开终端」的请求（文件树右键 / 侧栏 / 项目菜单）：每次 seq 变一下就新开一个分组，
	 * cwd 就是那个目录。`initialCommand` 给了就先敲进去（「↑ 有新版」的安装用它）。
	 * 同一个 seq 只处理一次。
	 */
	request?: { cwd: string; seq: number; initialCommand?: string } | null;
}) {
	const t = useT();
	const [height, setHeight] = useStoredNumber(HEIGHT_KEY, HEIGHT_DEFAULT, HEIGHT_MIN, HEIGHT_MAX);
	const [groups, setGroups] = useState<Group[]>([]);
	const [activeGroupId, setActiveGroupId] = useState<string | null>(null);

	const newGroup = useCallback((groupCwd: string | null, initialCommand: string | null = null) => {
		const pane: Pane = { id: nextId("bterm"), cwd: groupCwd, initialCommand };
		const group: Group = { id: nextId("bgroup"), panes: [pane], activePaneId: pane.id };
		setGroups((current) => [...current, group]);
		setActiveGroupId(group.id);
	}, []);

	/** 上一次已经处理过的「在某目录打开」请求序号（从 0 开始，请求 seq 从 1 起） */
	const handledSeq = useRef(0);
	// 打开时：有新请求就开请求的目录；否则如果一个分组都没有（第一次开，或者刚把最后一个关掉），自动新开一个
	useEffect(() => {
		if (!open) return;
		if (request && request.seq !== handledSeq.current) {
			handledSeq.current = request.seq;
			newGroup(request.cwd, request.initialCommand ?? null);
			return;
		}
		if (groups.length === 0) newGroup(cwd);
	}, [open, groups.length, request, cwd, newGroup]);

	// 当前分组被删掉了（或还没有）：兜底选中最后一个，免得界面上没有任何分组被选中
	useEffect(() => {
		if (groups.length === 0) return;
		if (activeGroupId && groups.some((group) => group.id === activeGroupId)) return;
		setActiveGroupId(groups[groups.length - 1].id);
	}, [groups, activeGroupId]);

	const removeGroup = (groupId: string) => {
		const next = groups.filter((group) => group.id !== groupId);
		setGroups(next);
		if (next.length === 0) onHide();
	};

	/** 关掉一屏；它是分组里的最后一屏时，整个分组一起关 */
	const removePane = (groupId: string, paneId: string) => {
		const group = groups.find((item) => item.id === groupId);
		if (!group) return;
		if (group.panes.length <= 1) {
			removeGroup(groupId);
			return;
		}
		const index = group.panes.findIndex((pane) => pane.id === paneId);
		const rest = group.panes.filter((pane) => pane.id !== paneId);
		setGroups((current) =>
			current.map((item) =>
				item.id !== groupId
					? item
					: {
							...item,
							panes: rest,
							activePaneId:
								item.activePaneId === paneId ? rest[Math.min(Math.max(index, 0), rest.length - 1)].id : item.activePaneId,
						},
			),
		);
	};

	/** 点到某一屏：它所在的分组切过去、这一屏变成焦点（点击/按下时调，已是焦点就不动） */
	const focusPane = (groupId: string, paneId: string) => {
		const group = groups.find((item) => item.id === groupId);
		if (group && activeGroupId === groupId && group.activePaneId === paneId) return;
		setActiveGroupId(groupId);
		setGroups((current) =>
			current.map((item) => (item.id === groupId ? { ...item, activePaneId: paneId } : item)),
		);
	};

	// 顶边拖拽：向上拖变高，向下拖变矮
	const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = height;
		const move = (ev: PointerEvent) => {
			const max = Math.min(HEIGHT_MAX, Math.round(window.innerHeight * HEIGHT_VIEWPORT_RATIO));
			const next = startHeight + (startY - ev.clientY);
			setHeight(Math.max(HEIGHT_MIN, Math.min(max, next)));
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	return (
		<section className="bottom-term" style={{ height }} hidden={!open} aria-label={t("终端", "Terminal")}>
			<div
				className="bottom-term-handle"
				role="separator"
				aria-orientation="horizontal"
				title={t("拖动调整高度", "Drag to resize")}
				onPointerDown={onHandleDown}
			/>
			<div className="bottom-term-bar">
				<div className="bottom-term-tabs" role="tablist">
					{groups.map((group, index) => {
						const active = group.id === activeGroupId;
						return (
							<div
								key={group.id}
								role="tab"
								aria-selected={active}
								className={`bottom-term-tab${active ? " is-active" : ""}`}
								title={group.panes[0]?.cwd ?? undefined}
								onClick={() => setActiveGroupId(group.id)}
							>
								<span>
									{t("终端", "Terminal")} {index + 1}
									{group.panes.length > 1 ? ` · ${group.panes.length}` : ""}
								</span>
								<button
									type="button"
									className="bottom-term-tab-x"
									title={t("关闭这个终端（含所有分屏）", "Kill this terminal (all splits)")}
									aria-label={t("关闭这个终端", "Kill this terminal")}
									onClick={(event) => {
										event.stopPropagation();
										removeGroup(group.id);
									}}
								>
									×
								</button>
							</div>
						);
					})}
				</div>
				<button
					type="button"
					className="bottom-term-btn"
					title={t("新建终端", "New terminal")}
					aria-label={t("新建终端", "New terminal")}
					onClick={() => newGroup(cwd)}
				>
					+
				</button>
				<span className="bottom-term-spacer" />
				{/* 设置：齿轮图标跟顶栏那颗同一套（PanelIcon），开的是同一个设置面板 */}
				{onOpenSettings ? (
					<button
						type="button"
						className="bottom-term-btn bottom-term-settings"
						title={t("设置", "Settings")}
						aria-label={t("设置", "Settings")}
						onClick={onOpenSettings}
					>
						<PanelIcon name="settings" />
					</button>
				) : null}
				<button
					type="button"
					className="bottom-term-btn"
					title={t("隐藏终端（进程保留）", "Hide terminal (shells keep running)")}
					aria-label={t("隐藏终端", "Hide terminal")}
					onClick={onHide}
				>
					⌄
				</button>
			</div>
			<div className="bottom-term-body">
				{groups.map((group) => (
					<div key={group.id} className="bottom-term-group" hidden={group.id !== activeGroupId}>
						{group.panes.map((pane) => {
							const focused = group.activePaneId === pane.id;
							return (
								<div
									key={pane.id}
									className={`bottom-term-pane${focused ? " is-focused" : ""}`}
									onPointerDown={() => focusPane(group.id, pane.id)}
								>
									<TerminalPanel
										termId={pane.id}
										cwd={pane.cwd}
										initialCommand={pane.initialCommand}
										active={open && group.id === activeGroupId && focused}
										onClose={() => removePane(group.id, pane.id)}
									/>
								</div>
							);
						})}
					</div>
				))}
			</div>
		</section>
	);
}
