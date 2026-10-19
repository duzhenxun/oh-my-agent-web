import { TOOL_EXCERPT_CHARS, type ToolBlock } from "../types.ts";

const STATUS_LABEL: Record<ToolBlock["status"], string> = { running: "运行中…", ok: "完成", failed: "失败" };

/** 从工具参数摘要里抠出图片路径（read / write 之类带 path 的工具） */
function imagePathOf(argsSummary: string): string | null {
	const match = /"path"\s*:\s*"([^"]+\.(?:png|jpe?g|gif|webp|avif|svg|bmp))"/i.exec(argsSummary);
	return match?.[1] ?? null;
}

/** 工具调用卡片（ADR-0012：工具输出只放摘录 + 截断标记） */
export function ToolCard({ block }: { block: ToolBlock }) {
	return (
		<details className={`tool tool-${block.status}`} open={block.status === "running"}>
			<summary className="tool-head">
				<span className="tool-name">{block.name}</span>
				<span className="tool-args">{block.argsSummary}</span>
				<span className={`tool-status tool-status-${block.status}`}>
					{STATUS_LABEL[block.status]}
					{block.exitCode === undefined ? "" : ` · exit ${block.exitCode}`}
				</span>
			</summary>
			{imagePathOf(block.argsSummary) ? (
				<div className="tool-image-wrap">
					<img
						className="tool-image"
						src={`/api/files/raw?path=${encodeURIComponent(imagePathOf(block.argsSummary) ?? "")}`}
						alt={block.name}
						loading="lazy"
					/>
				</div>
			) : null}
			<pre className="tool-output">{block.outputExcerpt || "（还没有输出）"}</pre>
			{block.truncated ? (
				<div className="tool-truncated">输出已截断：界面上只保留前 {TOOL_EXCERPT_CHARS} 字</div>
			) : null}
		</details>
	);
}
