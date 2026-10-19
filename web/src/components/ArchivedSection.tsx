import { ArchivedSessions } from "./ArchivedSessions.tsx";

/**
 * 「已归档」的入口 + 视图（从 Sidebar 抽出来：400 行护栏）。
 * 有归档时才显示入口；进入视图后 Sidebar 会把项目列表与文件区让开，视图吃满剩余高度。
 */
export function ArchivedSection({
	groups,
	view,
	onEnter,
	onBack,
	onOpen,
	onRestore,
}: {
	groups: { name: string; items: { id: string; title: string; time: string }[] }[];
	view: boolean;
	onEnter: () => void;
	onBack: () => void;
	onOpen: (id: string) => void;
	onRestore: (id: string) => void;
}) {
	const total = groups.reduce((sum, group) => sum + group.items.length, 0);
	if (total === 0 && !view) return null;
	return (
		<>
			{view ? null : (
				<button type="button" className="archived-entry" onClick={onEnter} title="查看已归档的会话">
					🗄 已归档 · {total}
				</button>
			)}
			{view ? <ArchivedSessions groups={groups} onBack={onBack} onOpen={onOpen} onRestore={onRestore} /> : null}
		</>
	);
}
