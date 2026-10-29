import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../use-language.ts";

/**
 * 「添加 MCP」（右栏）。
 *
 * 一个框什么都收：URL / 命令行 / `pi|claude mcp add …` / 一段 `mcpServers` JSON。
 * 解析在服务端（`server/mcp/mcp-import.ts`），这里只负责：
 *   - 边打边问一次 `action: "parse"`，把「会存成什么」实时显示出来（改名、丢字段都写出来）；
 *   - 作用域（全局 / 项目）与目标文件一直可见 —— 存错文件的代价比打错字大；
 *   - 右边挂几个市场链接（glama / smithery / mcp.so / 官方注册中心 / github），
 *     想自己逛的时候有地方去；想一键装就在「市场」那一页点。
 *
 * 为什么不放到左栏里（之前那样）：左栏只有 220px，命令放不下、提示挤成三行，
 * 而且「添加」是个**编辑动作**，跟右边那套「看/改这一台」的性质一致。
 */

/** 支持的格式：点一下就填进框里，省得对着占位符猜 */
const FORMAT_SAMPLES: { label: string; value: string; hint: string }[] = [
	{ label: "URL", value: "https://mcp.example.com/mcp", hint: "streamable HTTP 地址" },
	{
		label: "命令行",
		value: "npx -y @modelcontextprotocol/server-filesystem .",
		hint: "stdio：npx / uvx / node / 绝对路径都行",
	},
	{
		label: "pi mcp add",
		value: "pi mcp add docs --url https://mcp.example.com/mcp",
		hint: "也认 claude / codex / gemini 的 mcp add",
	},
	{
		label: "JSON",
		value:
			'{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n    }\n  }\n}',
		hint: "mcpServers / VS Code 的 servers / 单条片段都认",
	},
];

const CATALOG_LINKS = [
	{ href: "https://glama.ai/mcp/servers", label: "glama.ai" },
	{ href: "https://smithery.ai/servers", label: "smithery.ai" },
	{ href: "https://mcp.so/", label: "mcp.so" },
	{ href: "https://registry.modelcontextprotocol.io/", label: "MCP Registry" },
	{ href: "https://github.com/mcp", label: "github.com/mcp" },
];

type AddScope = "global" | "project";

export function McpAdd({
	text,
	onText,
	scope,
	scopePath,
	onScope,
	busy,
	onSubmit,
	onCancel,
}: {
	/** 粘的内容：**由面板持有**，切到市场看一眼再回来不会白丢 */
	text: string;
	onText: (text: string) => void;
	scope: AddScope;
	scopePath: string;
	onScope: (scope: AddScope) => void;
	/** 正在提交（按钮转圈） */
	busy: boolean;
	/** 提交：把这一整段交给服务端（`action: "add"`） */
	onSubmit: (text: string) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const [preview, setPreview] = useState<{ name: string; target: string }[] | null>(null);
	const [notes, setNotes] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const timer = useRef<number | null>(null);

	/**
	 * 边打边试解析：等 350ms 没人动再发（每敲一个字都打一次会把服务端刷满），
	 * 上一次没回来就丢掉（`latest` 计数），免得旧结果盖住新结果。
	 */
	const latest = useRef(0);
	const parse = useCallback(async (value: string) => {
		if (value.trim() === "") {
			setPreview(null);
			setNotes([]);
			setError(null);
			return;
		}
		const id = ++latest.current;
		try {
			const response = await fetch("/api/mcp", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "parse", text: value }),
			});
			const body = (await response.json()) as {
				preview?: { name: string; config: { url?: string; command?: string; args?: string[] } }[];
				notes?: string[];
				actionError?: string;
			};
			if (id !== latest.current) return;
			setNotes(body.notes ?? []);
			if (body.actionError !== undefined) {
				setPreview(null);
				setError(body.actionError);
				return;
			}
			setError(null);
			setPreview(
				(body.preview ?? []).map((server) => ({
					name: server.name,
					target:
						server.config.url ??
						[server.config.command ?? "", ...(server.config.args ?? [])].filter((part) => part !== "").join(" "),
				})),
			);
		} catch (cause) {
			if (id !== latest.current) return;
			setError(cause instanceof Error ? cause.message : String(cause));
			setPreview(null);
		}
	}, []);

	useEffect(() => {
		if (timer.current !== null) window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => void parse(text), 350);
		return () => {
			if (timer.current !== null) window.clearTimeout(timer.current);
		};
	}, [text, parse]);

	const canSubmit = !busy && text.trim() !== "" && error === null && (preview?.length ?? 0) > 0;

	return (
		<div className="mcp-add-pane">
			<div className="mcp-add-head">
				<span className="mcp-detail-name">{t("添加 MCP", "Add MCP")}</span>
				<span className="topbar-spacer" />
				{/* 市场链接：想自己逛的时候有地方去（一键装在上面的「市场」页） */}
				{CATALOG_LINKS.map((link) => (
					<a className="mcp-catalog-link" key={link.href} href={link.href} target="_blank" rel="noreferrer">
						{link.label}
					</a>
				))}
			</div>

			{/* 作用域：一直可见，存错文件比打错字更难查 */}
			<div className="mcp-scope-row">
				<div className="mcp-scope-tabs" role="tablist" aria-label={t("写到哪个作用域", "Which scope to write to")}>
					{(["global", "project"] as const).map((value) => (
						<button
							type="button"
							key={value}
							role="tab"
							aria-selected={scope === value}
							className={`mcp-scope-tab${scope === value ? " mcp-scope-tab-on" : ""}`}
							onClick={() => onScope(value)}
						>
							{value === "global" ? t("全局", "Global") : t("项目", "Project")}
						</button>
					))}
				</div>
				<span className="mcp-value mono mcp-scope-path" title={scopePath}>
					{scopePath}
				</span>
			</div>

			<label className="mcp-add-label" htmlFor="mcp-add-text">
				{t("要添加的服务器", "Server to add")}
			</label>
			<textarea
				id="mcp-add-text"
				className="mcp-add-text mono"
				value={text}
				spellCheck={false}
				placeholder={
					'https://mcp.example.com/mcp\nnpx -y @scope/server\npi mcp add docs --url https://mcp.example.com/mcp\n{ "mcpServers": { … } }'
				}
				onChange={(event) => onText(event.target.value)}
				onKeyDown={(event) => {
					// Ctrl/⌘+Enter 提交：多行框里回车得留给换行
					if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSubmit) onSubmit(text);
				}}
			/>

			<div className="mcp-add-actions">
				<button
					type="button"
					className="btn btn-tiny btn-primary-add"
					disabled={!canSubmit}
					onClick={() => onSubmit(text)}
				>
					{busy ? t("添加中…", "Adding…") : t("添加", "Add")}
				</button>
				<button type="button" className="btn btn-tiny" onClick={onCancel}>
					{t("取消", "Cancel")}
				</button>
				<span className="topbar-spacer" />
				<span className="side-panel-count">{t("⌘/Ctrl + Enter 也能提交", "⌘/Ctrl + Enter also submits")}</span>
			</div>

			{/* 试解析的结果：提交前先看清「会存成什么」 */}
			{error !== null ? <div className="side-panel-hint side-error">{error}</div> : null}
			{preview !== null && preview.length > 0 ? (
				<div className="mcp-add-preview">
					<span className="mcp-add-label">{t("会写成", "Will be written as")}</span>
					{preview.map((item) => (
						<div className="mcp-add-preview-row" key={item.name}>
							<span className="mcp-tool">{item.name}</span>
							<span className="mcp-value mono" title={item.target}>
								{item.target}
							</span>
						</div>
					))}
				</div>
			) : null}
			{notes.length > 0 ? (
				<ul className="mcp-add-notes">
					{notes.map((note, index) => (
						<li key={`${index}-${note}`}>{note}</li>
					))}
				</ul>
			) : null}

			<div className="mcp-add-samples">
				<span className="mcp-add-label">
					{t("支持的格式（点一下填入示例）", "Supported formats (click to fill an example)")}
				</span>
				{FORMAT_SAMPLES.map((sample) => (
					<button type="button" className="mcp-sample" key={sample.label} onClick={() => onText(sample.value)}>
						<span className="mcp-sample-label">{t(sample.label)}</span>
						<span className="mcp-sample-value mono">{sample.value.split("\n")[0]}</span>
						<span className="mcp-sample-hint">{t(sample.hint)}</span>
					</button>
				))}
			</div>

			<div className="side-panel-hint">
				{t("写进 pi 自己的", "Written into pi's own")} <code>mcp.json</code>，
				<strong>{t("对新会话生效", "effective for new sessions")}</strong>
				{t(
					"。同名不会覆盖：会自动加序号（预览里会写出来）。需要密钥的服务器，先把值写成",
					". Existing names are never overwritten — a suffix is added (shown in the preview). For servers that need a secret, write the value as",
				)}{" "}
				<code>{"${ENV_NAME}"}</code>
				{t("，面板里能看出这台机器上有没有设。", "; the panel shows whether it is set on this machine.")}
			</div>
		</div>
	);
}
