import { useCallback, useEffect, useState } from "react";
import { useT } from "../use-language.ts";

/**
 * 「MCP 市场」（右栏）：从公开注册中心拉一批服务器，一键写进 mcp.json。
 *
 * 页面结构：源选择 + 搜索 + 卡片 + 添加全局/添加项目。
 * 源只留两个**能真的装得下**的（见 `server/mcp/mcp-market.ts` 头注释）：
 *   官方注册中心（给 npm / PyPI 包与远程地址）、Smithery（托管的远程服务器）、
 *   加上 modelcontextprotocol/servers 官方参考服务器。
 *
 * 三条纪律：
 *   - **卡片上写清真会写入什么**（命令或地址），不让人点完才知道；
 *   - 已经装了的按名字标出来，不重复添加（重名会加序号，反而更乱）；
 *   - 拉不动就说拉不动（网络失败 / 只有旧缓存），不用假数据撑场面。
 */

type Source = "registry" | "smithery" | "github";

type Entry = {
	id: string;
	name: string;
	title: string;
	description: string;
	source: Source;
	homepage?: string;
	pkg?: string;
	downloads?: number;
	verified?: boolean;
	config: { url?: string; command?: string; args?: string[]; headers?: Record<string, string> };
	needsEnv?: string[];
	note?: string;
};

type MarketResponse = {
	ok?: boolean;
	entries?: Entry[];
	error?: string;
	cached?: boolean;
};

const SOURCES: { id: Source; label: string; hint: string }[] = [
	{ id: "registry", label: "官方注册中心", hint: "registry.modelcontextprotocol.io（npm / PyPI 与远程地址）" },
	{ id: "smithery", label: "Smithery", hint: "smithery.ai 托管的远程服务器，第一次连接可能要登录" },
	{ id: "github", label: "官方参考服务器", hint: "modelcontextprotocol/servers 仓库" },
];

/** 注册中心的描述里带 markdown（`[文字](url)`、`` `代码` ``）：卡片上只显示纯文本 */
function plainText(markdown: string): string {
	return markdown
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1");
}

function targetOf(entry: Entry): string {
	if (entry.config.url !== undefined) return entry.config.url;
	return [entry.config.command ?? "", ...(entry.config.args ?? [])].filter((part) => part !== "").join(" ");
}

/** 服务端下发的 note（中文短句）：`版本 1.0.0` 这种带动态值的单独拼，其余直接查字典 */
function noteText(note: string, t: (zh: string, en?: string) => string): string {
	if (note.startsWith("版本 ")) return `${t("版本", "Version")} ${note.slice(3)}`;
	return t(note);
}

export function McpMarket({
	installed,
	busy,
	source,
	onSource,
	query,
	onQuery,
	onAdd,
}: {
	/** 已配置的服务器名（同名的卡片标「已添加」） */
	installed: string[];
	busy: boolean;
	/** 源与搜索词：**由面板持有**（切到「添加」再回来不用重新选一遍、重新搜一遍） */
	source: Source;
	onSource: (source: Source) => void;
	query: string;
	onQuery: (query: string) => void;
	/** 一键添加：把卡片里的 config 交给服务端 */
	onAdd: (entry: Entry, scope: "global" | "project") => void;
}) {
	const t = useT();
	/** 真正发出去的查询词（输入防抖后才写它） */
	const [applied, setApplied] = useState("");
	const [entries, setEntries] = useState<Entry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [nonce, setNonce] = useState(0);

	// 输入防抖：搜索在服务端是本地过滤（缓存命中时很快），但换源/换词都会打一次
	useEffect(() => {
		const timer = window.setTimeout(() => setApplied(query.trim()), 400);
		return () => window.clearTimeout(timer);
	}, [query]);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		void (async () => {
			try {
				const params = new URLSearchParams({ source, q: applied });
				if (nonce > 0) params.set("refresh", "1");
				const response = await fetch(`/api/mcp/market?${params.toString()}`);
				const body = (await response.json()) as MarketResponse;
				if (cancelled) return;
				if (!response.ok || body.ok === false) {
					setEntries(null);
					setError(body.error ?? `HTTP ${response.status}`);
					return;
				}
				setEntries(body.entries ?? []);
				setError(body.error ?? null);
			} catch (cause) {
				if (cancelled) return;
				setEntries(null);
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [source, applied, nonce]);

	const refresh = useCallback(() => setNonce((value) => value + 1), []);
	const current = SOURCES.find((item) => item.id === source);
	const taken = new Set(installed);

	return (
		<div className="mcp-market">
			<div className="mcp-add-head">
				<span className="mcp-detail-name">{t("MCP 市场")}</span>
				<span className="topbar-spacer" />
				<span className="side-panel-count">
					{entries === null ? "" : t(`${entries.length} 个`, `${entries.length}`)}
				</span>
				<button
					type="button"
					className="btn btn-tiny"
					disabled={loading}
					onClick={refresh}
					title={t("忽略缓存重新拉一次", "Fetch again, ignoring the cache")}
				>
					{loading ? t("拉取中…", "Fetching…") : t("刷新", "Refresh")}
				</button>
			</div>

			<div className="mcp-market-bar">
				<select
					className="mcp-market-source"
					value={source}
					onChange={(event) => onSource(event.target.value as Source)}
					title={t("从哪个源拉")}
				>
					{SOURCES.map((item) => (
						<option value={item.id} key={item.id}>
							{t(item.label)}
						</option>
					))}
				</select>
				<input
					className="mcp-market-search"
					value={query}
					placeholder={t("搜索名称、包名或能力描述…")}
					onChange={(event) => onQuery(event.target.value)}
				/>
			</div>
			{current ? <span className="side-panel-count">{t(current.hint)}</span> : null}

			{error !== null ? <div className="side-panel-hint side-error">{error}</div> : null}
			{entries === null && loading ? (
				<div className="side-panel-hint">{t("正在拉取市场清单…（官方注册中心首次要十几秒）")}</div>
			) : null}
			{entries !== null && entries.length === 0 && !loading ? (
				<div className="side-panel-hint">{t("这个源里没有匹配的服务器，换个词或换个源试试。")}</div>
			) : null}

			<div className="mcp-market-list">
				{(entries ?? []).map((entry) => {
					const already = taken.has(entry.name);
					return (
						<div className="mcp-market-card" key={entry.id}>
							<div className="mcp-market-card-head">
								<span className="mcp-market-title">{entry.title}</span>
								{entry.verified ? <span className="mcp-badge">{t("官方")}</span> : null}
								<span className="topbar-spacer" />
								{entry.homepage ? (
									<a className="mcp-catalog-link" href={entry.homepage} target="_blank" rel="noreferrer">
										{t("主页", "Home")} ↗
									</a>
								) : null}
							</div>
							{entry.description ? <p className="mcp-market-desc">{plainText(entry.description)}</p> : null}
							<div className="mcp-market-target">
								<span className="mcp-value mono" title={targetOf(entry)}>
									{entry.pkg ?? targetOf(entry)}
								</span>
								{entry.downloads !== undefined ? (
									<span className="side-panel-count">
										{t(`${entry.downloads.toLocaleString()} 次使用`, `${entry.downloads.toLocaleString()} uses`)}
									</span>
								) : null}
							</div>
							{entry.needsEnv && entry.needsEnv.length > 0 ? (
								<div className="mcp-market-needs">
									{t("装好后还要补环境变量：", "Set these environment variables after installing:")}
									{entry.needsEnv.map((name) => (
										<span className="mcp-tool" key={name}>
											{name}
										</span>
									))}
								</div>
							) : null}
							{entry.note ? <div className="side-panel-count">{noteText(entry.note, t)}</div> : null}
							<div className="mcp-market-actions">
								{already ? <span className="side-panel-count">{t("已有同名配置")}</span> : null}
								<button
									type="button"
									className="btn btn-tiny"
									disabled={busy}
									onClick={() => onAdd(entry, "global")}
									title={t("写进 ~/.pi/agent/mcp.json")}
								>
									＋ {t("添加全局", "Add globally")}
								</button>
								<button
									type="button"
									className="btn btn-tiny"
									disabled={busy}
									onClick={() => onAdd(entry, "project")}
									title={t("写进当前项目的 .pi/mcp.json")}
								>
									＋ {t("添加项目", "Add to project")}
								</button>
							</div>
						</div>
					);
				})}
			</div>

			<div className="side-panel-hint">
				{t(
					"清单来自公开注册中心（1 小时磁盘缓存）。一键添加只写 mcp.json 里那一条配置，卡上写明要补的环境变量，",
					"The list comes from the public registry (1-hour disk cache). One-click add writes only the single mcp.json entry; missing environment variables are listed on the card —",
				)}
				<strong>{t("对新会话生效", "effective for new sessions")}</strong>
				{t("。", ".")}
			</div>
		</div>
	);
}
