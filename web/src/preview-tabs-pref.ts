/**
 * 右侧分栏的**标签**在刷新后恢复（纯本机偏好，存 localStorage）。
 *
 * 为什么要有：面板里开着的文件 / 网页 / 终端，一刷新全没了 —— 而「我刚在看这几个东西」
 * 跟「左侧选了哪个项目」是同一类状态，应该活过刷新。
 *
 * 恢复什么、不恢复什么（这几条是刻意的）：
 *   - **文件**（`path + root`）与**网页**（`url`）：恢复 —— 纯读，最值钱的一类；
 *   - **文件树（files）**：恢复（只是个工具标签，没有正文）；
 *   - **终端：不恢复**。刷新后 PTY 已经随页面结束了，恢复出来的是「同目录的一个新 shell」——
 *     看着像原来那个、其实不是，而且刷几次就攒一堆孤儿 shell；
 *   - **临时聊天：不恢复**。它本来就不落盘，重连旧通道会拿回一条「上一页的」会话，
 *     反倒像幽灵；关掉再走一遍「问一句就走」才是它的用法。
 *
 * 存的是纯数据，不存 id：id 里有会话序号 / 项目根，重建时按当前状态重新生成，
 * 只有文件的 id 是确定性的（`file:root:path`，跟 `openFileInPanel` 同一套，不会重复开）。
 */
import type { PanelItem } from "./components/PreviewPanel.tsx";

export const PANEL_STATE_KEY = "agent-web.preview.tabs.v1";

/** 最多恢复这么多标签：手滑开二十个也不该在刷新后原样铺回来 */
const MAX_RESTORED_TABS = 10;

type StoredTab = { kind: "file"; path: string; root: string } | { kind: "web"; url: string } | { kind: "files" };

type StoredPanelState = {
	tabs: StoredTab[];
	/** 刷新前聚焦的那条（找不到就用第一条） */
	active: string | null;
	/** 刷新前面板是开着还是收着 */
	open: boolean;
};

type AnyItem = { id: string; kind: string; path?: string; root?: string; url?: string };

/**
 * 一条条目 → 可存的样子。
 * 终端与临时聊天**一律返回 null**（不存，理由见文件头）：它们不是「看一眼的东西」，
 * 而是活着的进程 / 内存里的会话，刷新后强行恢复只会骗人。
 */
function toStoredTab(item: AnyItem): StoredTab | null {
	if (item.kind === "file" && item.path && item.root !== undefined) {
		return { kind: "file", path: item.path, root: item.root };
	}
	if (item.kind === "web") return { kind: "web", url: item.url ?? "" };
	if (item.kind === "files") return { kind: "files" };
	return null;
}

/** 存的东西 → 面板条目（id 按当前状态重新生成；坏条目直接跳过，不整个放弃） */
export function restorePanelItems(tabs: readonly StoredTab[]): PanelItem[] {
	const items: PanelItem[] = [];
	tabs.slice(0, MAX_RESTORED_TABS).forEach((tab, index) => {
		if (tab.kind === "file") {
			// 跟 `openFileInPanel` 同一个 id 规则：同一条会话里不会出现两份同一个文件
			items.push({ id: `file:${tab.root}:${tab.path}`, kind: "file", path: tab.path, root: tab.root });
		} else if (tab.kind === "web") {
			items.push({ id: `web:restored:${index}`, kind: "web", url: tab.url });
		} else {
			items.push({ id: `files:restored:${index}`, kind: "files" });
		}
	});
	return items;
}

/** 解析存下来的整包；坏 JSON / 结构不对都回 null（= 当作没存过） */
export function parsePanelState(raw: string | null): StoredPanelState | null {
	if (raw === null) return null;
	try {
		const value = JSON.parse(raw) as { tabs?: unknown; active?: unknown; open?: unknown };
		if (!Array.isArray(value?.tabs)) return null;
		const tabs = value.tabs.filter(isStoredTab);
		if (tabs.length === 0) return null;
		return {
			tabs: tabs.slice(0, MAX_RESTORED_TABS),
			active: typeof value.active === "string" ? value.active : null,
			open: value.open === true,
		};
	} catch {
		return null;
	}
}

/** 一条存下来的标签是不是还能用（缺字段 / 类型不对就丢这一条） */
function isStoredTab(value: unknown): value is StoredTab {
	if (typeof value !== "object" || value === null) return false;
	const tab = value as Record<string, unknown>;
	if (tab.kind === "file") return typeof tab.path === "string" && tab.path !== "" && typeof tab.root === "string";
	if (tab.kind === "web") return typeof tab.url === "string";
	return tab.kind === "files";
}

/**
 * 打包成要写进 localStorage 的字符串。
 *
 * `active` 只保留**真的会被恢复的那一条**：临时聊天不存，而它可能正是当时聚焦的那条 ——
 * 原样写下去，刷新后就会去聚焦一个不存在的 id（渲染虽然会回落到第一条，但那是个脏值）。
 */
export function serializePanelState(items: readonly PanelItem[], active: string | null, open: boolean): string {
	const kept: StoredTab[] = [];
	let activeStored: string | null = null;
	for (const item of items) {
		if (kept.length >= MAX_RESTORED_TABS) break;
		const stored = toStoredTab(item);
		if (stored === null) continue;
		kept.push(stored);
		if (item.id === active) activeStored = item.id;
	}
	return JSON.stringify({ tabs: kept, active: activeStored, open });
}
