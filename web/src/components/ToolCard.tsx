import { useState } from "react";
import { basename } from "../path-utils.ts";
import { openImageViewer } from "../image-viewer.ts";
import { useStickToBottom } from "../stick-to-bottom.ts";
import { TOOL_EXCERPT_CHARS, type ToolBlock } from "../types.ts";
import { TOOL_OPEN_KEY } from "../ui-prefs.ts";
import { useStoredBool } from "../use-stored-bool.ts";
import { CopyButton } from "./CopyButton.tsx";
import { tNow, useT } from "../use-language.ts";

const STATUS_LABEL: Record<ToolBlock["status"], string> = { running: "运行中…", ok: "完成", failed: "失败" };

/** 名字看起来是「跑命令」的工具：这些即使参数很短也把命令块摆出来（就为了能一键复制） */
const SHELL_NAMES = /^(bash|sh|shell|shell_command|exec|run|run_command|terminal)$/i;

/**
 * 展开后要显示的那段「原文」：优先用完整参数，并尽量把命令本身抽出来。
 *
 * 为什么不是直接把 `argsSummary` 放大：那是 `{"command":"cd … \u0026\u0026 …"}` 这种 JSON，
 * 既被截断了 200 字，又满屏转义符 —— 人要看的是命令，不是 JSON。所以：
 *   - 参数里带 `command` 字段 → 只显示那个字段（最干净，也方便直接粘回终端）；
 *   - 其它对象 → 缩进后的 JSON（好看一点）；
 *   - 本来就是字符串（有的引擎直接给命令串）→ 原样。
 */
function fullTextOf(block: ToolBlock): string | null {
	const raw = (block.argsFull ?? block.argsSummary).trim();
	if (raw === "") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "string") return parsed;
		if (parsed && typeof parsed === "object") {
			const command = (parsed as Record<string, unknown>).command;
			if (typeof command === "string" && command.trim() !== "") return command;
			return JSON.stringify(parsed, null, 2);
		}
	} catch {
		// 不是 JSON：本来就是个原始字符串（比如某些引擎直接给命令行）→ 原样显示
	}
	return raw;
}

/**
 * 从工具参数原文里抠出「一行能看的那段」：JSON 就取 command / path 字段，否则原样。
 *
 * 给「正在运行 bash…」这类实时动作提示用：抬头那边 `{"command":"cd …"}` 很吵，
 * 用户想看的是一行命令（或者被改的文件）。截断过的 JSON parse 不出来 → 原样退回。
 */
export function argsPreview(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === "string") return parsed;
		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			for (const key of ["command", "path", "pattern", "query"]) {
				const value = record[key];
				if (typeof value === "string" && value.trim() !== "") return value;
			}
			return JSON.stringify(parsed);
		}
	} catch {
		// 不是 JSON（或已被摘要截断）→ 原样显示
	}
	return trimmed;
}

/**
 * 「完整命令」块：展开才出现，带一个复制按钮。
 *
 * 只在这些时候出现：摘要被截断了（`argsFull` 比 `argsSummary` 长），或者本来就是个跑命令的工具 ——
 * 否则 `read {"path":"x"}` 这种抬头已经写全了，再摆一遍只是噪声。
 */
function ToolCommand({ block }: { block: ToolBlock }) {
	const t = useT();
	const text = fullTextOf(block);
	if (text === null) return null;
	const truncated = block.argsFull !== undefined && block.argsFull !== block.argsSummary;
	if (!truncated && !SHELL_NAMES.test(block.name)) return null;
	return (
		<div className="tool-command">
			<div className="tool-command-head">
				<span className="tool-command-label">
					{SHELL_NAMES.test(block.name) ? t("命令", "Command") : t("参数", "Arguments")}
				</span>
				<CopyButton
					text={text}
					className="msg-action tool-command-copy"
					title={t("复制完整命令", "Copy the full command")}
				/>
			</div>
			<pre className="tool-command-text">{text}</pre>
		</div>
	);
}

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
function ToolImage({ block }: { block: ToolBlock }) {
	const imagePath = imagePathOf(block.argsSummary);
	if (!imagePath) return null;
	return (
		// 点一下在原地弹大图（Esc / 点空白关闭），不开新标签页打断阅读
		<button
			type="button"
			className="tool-image-wrap"
			title={`${imagePath}（点击放大预览）`}
			onClick={() => openImageViewer(rawSrcOf(imagePath), basename(imagePath) || "图片")}
		>
			<img className="tool-image" src={rawSrcOf(imagePath)} alt={basename(imagePath) || "图片"} loading="lazy" />
		</button>
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
	/**
	 * 默认展开的优先级：**本卡手动点过** → 跑着的卡 → 「设置 → 界面 → 过程 → 默认展开工具卡」。
	 * 跑着的卡始终默认展开（能看实时输出），这点不受偏好影响；跑完就回到偏好决定的状态。
	 */
	const [manualOpen, setManualOpen] = useState<boolean | null>(null);
	const [defaultOpen] = useStoredBool(TOOL_OPEN_KEY, false);
	const open = manualOpen ?? (block.status === "running" || defaultOpen);
	/**
	 * 输出框自己跟着进度往下走：跑着的卡里字一直在长，滚动条却停在原处 —— 看到的永远是开头那几行，
	 * 得手动拖才能看到当下在干什么。这里复用摘要区的粘底逻辑（同样不会抢用户的滚动）。
	 * 跑完就关掉（active=false）：展开一条旧记录是想从头读，不该直接跳到尾巴。
	 */
	const outputScroll = useStickToBottom(String(block.outputExcerpt.length), null, block.status === "running");
	return (
		<div className={`tool tool-${block.status}`}>
			<details
				open={open}
				onToggle={(event) => {
					// 浏览器已经把 open 状态翻过了：跟当前渲染值不一致 = 用户点的，记下来（手动优先）
					const next = event.currentTarget.open;
					if (next !== open) setManualOpen(next);
				}}
			>
				<summary className="tool-head">
					<span className="tool-name">{block.name}</span>
					<span className="tool-args">{block.argsSummary}</span>
					<span className={`tool-status tool-status-${block.status}`}>
						{/* 转圈放在文字前面：一眼看到「还在动」，而不只是读到一个灰字 */}
						{block.status === "running" ? <span className="tool-spinner" aria-hidden="true" /> : null}
						{STATUS_LABEL[block.status]}
						{block.exitCode === undefined ? "" : ` · exit ${block.exitCode}`}
					</span>
				</summary>
				<ToolCommand block={block} />
				<pre className="tool-output" ref={outputScroll.ref}>
					{block.outputExcerpt || "（还没有输出）"}
				</pre>
				{block.truncated ? (
					<div className="tool-truncated">
						{tNow("输出已截断：界面上只保留前", "Output truncated: only the first")} {TOOL_EXCERPT_CHARS}{" "}
						{tNow("字", "characters are shown")}
					</div>
				) : null}
			</details>
			<ToolImage block={block} />
		</div>
	);
}
