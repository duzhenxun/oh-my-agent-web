import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, withThousands, type HubPage, type HubSkill } from "../skills-view.ts";
import { useT } from "../use-language.ts";

/**
 * 「技能库」：SkillHub（skillhub.tencent.com）市场——搜索框 + 一排分类 +
 * 卡片（未安装 / 作者 / 来源 / 下载 / 收藏）+ 一键安装。
 *
 * 几条取舍：
 *   - 分类 key 用它前端那 8 个（接口会做别名映射，实测每个 key 命中数不同），
 *     但**分类清单从服务端拿**（`categories`），免得两边各写一份慢慢对不上；
 *   - 已安装用目录名比（安装时目录名就是 slug），卡片上直接标「已安装」；
 *   - 分页是「加载更多」，不做无限滚动 —— 弹窗里滚动事件容易跟外层抢。
 *
 * 卡片上把**会装到哪**写清楚（`~/.agents/skills/<slug>`），
 * 因为 oh-my-agent-web 只有这一个落点，用户不必再选目标目录。
 */
export function SkillsHub({
	root,
	onInstalled,
	onOpenGit,
}: {
	/** 安装根目录（显示用：`~/.agents/skills`） */
	root: string;
	onInstalled: (result: {
		notice?: string;
		installError?: string;
		skills?: import("../skills-view.ts").Skill[];
	}) => void;
	onOpenGit: () => void;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [applied, setApplied] = useState("");
	const [category, setCategory] = useState("");
	const [categories, setCategories] = useState<{ key: string; label: string }[]>([]);
	const [skills, setSkills] = useState<HubSkill[] | null>(null);
	const [page, setPage] = useState(1);
	const [hasMore, setHasMore] = useState(false);
	const [total, setTotal] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [installing, setInstalling] = useState<string | null>(null);
	const requestId = useRef(0);

	// 输入防抖：SkillHub 的搜索是它自己做的，每敲一个字都打一次既慢又费
	useEffect(() => {
		const timer = window.setTimeout(() => setApplied(query.trim()), 400);
		return () => window.clearTimeout(timer);
	}, [query]);

	const load = useCallback(
		async (nextPage: number, append: boolean) => {
			const id = ++requestId.current;
			setLoading(true);
			setError(null);
			try {
				const params = new URLSearchParams({ q: applied, category, page: String(nextPage) });
				const response = await fetch(`/api/skills/hub?${params.toString()}`);
				const body = (await response.json()) as HubPage;
				if (id !== requestId.current) return;
				if (!response.ok) {
					setError(errorText(body, response.status));
					if (!append) setSkills([]);
					return;
				}
				if (body.categories) setCategories(body.categories);
				const list = body.skills ?? [];
				setSkills((current) => (append && current !== null ? [...current, ...list] : list));
				setPage(nextPage);
				setHasMore(body.hasMore === true);
				setTotal(body.total ?? null);
			} catch (cause) {
				if (id !== requestId.current) return;
				setError(cause instanceof Error ? cause.message : String(cause));
				if (!append) setSkills([]);
			} finally {
				if (id === requestId.current) setLoading(false);
			}
		},
		[applied, category],
	);

	useEffect(() => {
		void load(1, false);
	}, [load]);

	const install = async (skill: HubSkill) => {
		setInstalling(skill.slug);
		try {
			const response = await fetch("/api/skills/install", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: "hub", slug: skill.slug, name: skill.slug }),
			});
			const body = (await response.json()) as { notice?: string; installError?: string; skills?: never };
			onInstalled(body);
			// 装完把这张卡标成已安装（不重新拉列表：会跳回第一页）
			if (body.notice !== undefined) {
				setSkills(
					(current) => current?.map((item) => (item.slug === skill.slug ? { ...item, installed: true } : item)) ?? null,
				);
			}
		} catch (cause) {
			onInstalled({ installError: cause instanceof Error ? cause.message : String(cause) });
		} finally {
			setInstalling(null);
		}
	};

	return (
		<div className="skills-hub">
			<form
				className="skills-hub-search"
				onSubmit={(event) => {
					event.preventDefault();
					setApplied(query.trim());
					void load(1, false);
				}}
			>
				<input
					className="skills-input"
					value={query}
					placeholder={t(
						"搜索 SkillHub 的技能（名字、用途、关键词）",
						"Search SkillHub skills (name, purpose, keywords)",
					)}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<button type="submit" className="btn btn-tiny btn-primary-add" disabled={loading}>
					{loading ? t("搜索中…", "Searching…") : t("搜索", "Search")}
				</button>
			</form>

			<div className="skills-hub-cats">
				{(categories.length > 0 ? categories : [{ key: "", label: "全部" }]).map((item) => (
					<button
						type="button"
						key={item.key || "all"}
						className={`skills-cat${category === item.key ? " skills-cat-on" : ""}`}
						onClick={() => {
							setCategory(item.key);
							setApplied(query.trim());
						}}
					>
						{t(item.label)}
					</button>
				))}
			</div>

			<div className="skills-hub-meta">
				<span className="side-panel-count">
					{total !== null ? t(`共 ${withThousands(total)} 个技能`, `${withThousands(total)} skills in total`) : ""}
					{skills !== null ? ` · ${t("已列出", "showing")} ${skills.length}` : ""} · {t("安装到", "installed to")}{" "}
					<code>{root}</code>
				</span>
				<span className="topbar-spacer" />
				<button type="button" className="btn btn-tiny" onClick={onOpenGit}>
					{t("从 Git 仓库装", "Install from a Git repo")} ↗
				</button>
			</div>

			{error !== null ? <div className="side-panel-hint side-error">{error}</div> : null}
			{skills === null && loading ? (
				<div className="side-panel-hint">{t("正在读取技能库…", "Loading the skill hub…")}</div>
			) : null}
			{skills !== null && skills.length === 0 && !loading ? (
				<div className="side-panel-hint">
					{t("没有匹配的技能，换个词或换个分类试试。", "No matching skills — try another word or category.")}
				</div>
			) : null}

			{/* key 带上查询签名：换词/换分类时整块重建，别让 React 拿旧节点去复用 */}
			<div className="skills-hub-list" key={`${applied}|${category}`}>
				{(skills ?? []).map((skill, index) => (
					<div className="skill-card" key={`${skill.slug}-${index}`}>
						<div className="skill-card-head">
							<span className="skill-card-name">{skill.name}</span>
							{skill.installed ? (
								<span className="mcp-badge skill-badge-on">{t("已安装", "Installed")}</span>
							) : (
								<span className="mcp-badge">{t("未安装", "Not installed")}</span>
							)}
							{skill.author ? (
								<span className="mcp-badge">
									{t("作者", "by")} {skill.author}
								</span>
							) : null}
							{skill.categoryLabel ? <span className="mcp-badge">{t(skill.categoryLabel)}</span> : null}
							{skill.downloads !== undefined ? (
								<span className="mcp-badge">
									{t("下载", "Downloads")} {withThousands(skill.downloads)}
								</span>
							) : null}
							{skill.stars !== undefined ? (
								<span className="mcp-badge">
									{t("收藏", "Stars")} {withThousands(skill.stars)}
								</span>
							) : null}
						</div>
						{skill.description !== "" ? <p className="skill-card-desc">{skill.description}</p> : null}
						<div className="skill-card-foot">
							<span className="skill-slug mono">{skill.slug}</span>
							<span className="topbar-spacer" />
							{skill.homepage ? (
								<a className="mcp-catalog-link" href={skill.homepage} target="_blank" rel="noreferrer">
									{t("详情", "Details")} ↗
								</a>
							) : null}
							<button
								type="button"
								className="btn btn-tiny btn-primary-add"
								disabled={installing !== null || skill.installed === true}
								onClick={() => void install(skill)}
								title={skill.installed ? "本机已有同名目录" : `装到 ${root}/${skill.slug}`}
							>
								{installing === skill.slug
									? t("安装中…", "Installing…")
									: skill.installed
										? t("已安装", "Installed")
										: t("安装", "Install")}
							</button>
						</div>
					</div>
				))}
			</div>

			{hasMore ? (
				<div className="skills-hub-more">
					<button type="button" className="btn btn-tiny" disabled={loading} onClick={() => void load(page + 1, true)}>
						{loading ? t("加载中…", "Loading…") : t("加载更多", "Load more")}
					</button>
				</div>
			) : null}

			<div className="side-panel-hint">
				{t("技能来自", "Skills come from")} <code>skillhub.tencent.com</code>
				{t(
					"（公开接口，5 分钟内重复搜索走缓存）。安装 = 下载 zip 整目录解到",
					"(public API; repeated searches within 5 minutes are cached). Installing = download the zip and unpack the whole folder into",
				)}{" "}
				<code>{root}</code>
				{t("，同名已存在不会覆盖。", "; an existing folder with the same name is never overwritten.")}
			</div>
		</div>
	);
}
