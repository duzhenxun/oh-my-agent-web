import { TOOL_EXCERPT_CHARS, type ToolBlock } from "../types.ts";

const STATUS_LABEL: Record<ToolBlock["status"], string> = { running: "运行中…", ok: "完成", failed: "失败" };

/** 从工具参数摘要里抠出图片路径（read / write 之类带 path 的工具） */
function imagePathOf(argsSummary: string): string | null {
	const match = /"path"\s*:\s*"([^"]+\.(?:png|jpe?g|gif|webp|avif|svg|bmp))"/i.exec(argsSummary);
	return match?.[1] ?? null;
}

/** 图片地址：交给服务端解析（绝对路径也认，模型读 /tmp、桌面上的图都能显示） */
function rawSrcOf(path: string): string {
	return `/api/files/raw?path=${encodeURIComponent(path)}`;
}

/**
 * 只渲染「这次工具调用看过的图」——没有图就是 null。
 *
 * 单独抽出来的理由：工具调用整组默认是折叠的（看不见过程），
 * 但图片是**消息内容**，不该跟着藏起来（见 MessageList 里的用法）。
 */
export function ToolImage({ block }: { block: ToolBlock }) {
	const imagePath = imagePathOf(block.argsSummary);
	if (!imagePath) return null;
	return (
		// 点一下看原图（新标签页），不在对话里弹大图打断阅读
		<a
			className="tool-image-wrap"
			href={rawSrcOf(imagePath)}
			target="_blank"
			rel="noreferrer"
			title={`${imagePath}（点击看原图）`}
		>
			<img className="tool-image" src={rawSrcOf(imagePath)} alt={imagePath.split("/").pop() ?? "图片"} loading="lazy" />
		</a>
	);
}

/**
 * 工具调用卡片（ADR-0012：工具输出只放摘录 + 截断标记）。
 *
 * 图片单独放在 `<details>` **外面**：工具输出默认是折叠的，若把图塞进折叠体里，
 * 模型读了一张图之后界面上只看得见一行 `read {"path":"…"}` —— 图等于没显示。
 * 所以这里拆成「可折叠的文字部分」+「常显的图片部分」。
 */
export function ToolCard({ block }: { block: ToolBlock }) {
	return (
		<div className={`tool tool-${block.status}`}>
			<details open={block.status === "running"}>
				<summary className="tool-head">
					<span className="tool-name">{block.name}</span>
					<span className="tool-args">{block.argsSummary}</span>
					<span className={`tool-status tool-status-${block.status}`}>
						{STATUS_LABEL[block.status]}
						{block.exitCode === undefined ? "" : ` · exit ${block.exitCode}`}
					</span>
				</summary>
				<pre className="tool-output">{block.outputExcerpt || "（还没有输出）"}</pre>
				{block.truncated ? (
					<div className="tool-truncated">输出已截断：界面上只保留前 {TOOL_EXCERPT_CHARS} 字</div>
				) : null}
			</details>
			<ToolImage block={block} />
		</div>
	);
}
