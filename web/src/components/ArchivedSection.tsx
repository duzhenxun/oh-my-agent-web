import { ArchivedSessions } from "./ArchivedSessions.tsx";

/**
 * 「已归档」视图（入口已挪到侧栏标题栏的 🗄 图标，见 Sidebar.tsx）。
 * 进入视图后 Sidebar 会把项目列表与文件区让开，视图吃满剩余高度。
 */
export function ArchivedSection({
	groups,
	view,
	onBack,
	onOpen,
	onRestore,
}: {
	groups: { name: string; items: { id: string; title: string; time: string }[] }[];
	view: boolean;
	onBack: () => void;
	onOpen: (id: string) => void;
	onRestore: (id: string) => void;
}) {
	if (!view) return null;
	return <ArchivedSessions groups={groups} onBack={onBack} onOpen={onOpen} onRestore={onRestore} />;
}
