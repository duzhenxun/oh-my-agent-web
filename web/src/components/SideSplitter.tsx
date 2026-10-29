/**
 * 会话列表与「文件管理」之间的分隔条。
 *
 * **一直显示**（收起文件区时它就是「文件管理」的上边界），按住上下拖可以改文件区高度；
 * 收起状态下拖它 = 顺手把文件区拉开（否则拖了没反应）。双击复位。
 */
import { useT } from "../use-language.ts";
export function SideSplitter({
	open,
	onOpen,
	onStart,
	onReset,
}: {
	open: boolean;
	onOpen: () => void;
	onStart: (event: React.PointerEvent<HTMLDivElement>) => void;
	onReset: () => void;
}) {
	const t = useT();
	return (
		<div
			className="side-split"
			role="separator"
			aria-orientation="horizontal"
			title={t("拖动调整文件区高度（双击复位）")}
			onPointerDown={(event) => {
				if (!open) onOpen();
				onStart(event);
			}}
			onDoubleClick={onReset}
		/>
	);
}
