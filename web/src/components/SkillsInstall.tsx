import { useState } from "react";
import type { InstallResponse, Skill } from "../skills-view.ts";
import { useT } from "../use-language.ts";

/**
 * 「Git 仓库」与「手动创建」两个页签（技能库在 SkillsHub.tsx）。
 *
 * Git 走**两段式**：先克隆一份、列出仓库里有哪些技能（根目录与 `skills/` 都认），
 * 再挑一个装 —— 一个仓库常常带十几个技能，
 * 直接「粘地址就装」你根本不知道会装进来什么。克隆目录用完即删。
 *
 * 手动创建只写一份 `SKILL.md`（frontmatter 用 pi 认的 `name` / `description`），
 * 其余文件以后在磁盘上自己加就行。
 */
export function SkillsInstall({
	root,
	tab,
	onTab,
	onInstalled,
}: {
	root: string;
	tab: "git" | "manual";
	onTab: (tab: "git" | "manual" | "hub") => void;
	onInstalled: (result: { notice?: string; installError?: string; skills?: Skill[] }) => void;
}) {
	const t = useT();
	const [repoUrl, setRepoUrl] = useState("");
	const [repoSkills, setRepoSkills] = useState<string[] | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [raw, setRaw] = useState("");

	const post = async (payload: Record<string, unknown>) => {
		const response = await fetch("/api/skills/install", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		return (await response.json()) as InstallResponse;
	};

	const listRepo = async () => {
		setBusy("list");
		setError(null);
		setRepoSkills(null);
		try {
			const body = await post({ source: "git", repoUrl });
			if (body.ok === true) setRepoSkills(body.skills as unknown as string[]);
			else setError(body.error ?? body.installError ?? t("拉取失败", "Failed to fetch"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	};

	const installFromRepo = async (skill: string) => {
		setBusy(skill);
		try {
			const body = await post({ source: "git", repoUrl, skill });
			onInstalled(body);
			if (body.notice !== undefined) {
				setRepoSkills((current) => current?.filter((item) => item !== skill) ?? null);
			} else if (body.installError !== undefined) {
				setError(body.installError);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	};

	const createManual = async () => {
		setBusy("create");
		try {
			const body = await post({ source: "manual", name, raw });
			onInstalled(body);
			if (body.notice !== undefined) {
				setName("");
				setRaw("");
			} else if (body.installError !== undefined) {
				setError(body.installError);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="skills-install-pane">
			<div className="skills-tabs" role="tablist" aria-label={t("安装方式", "Install method")}>
				<button type="button" role="tab" aria-selected={false} className="skills-tab" onClick={() => onTab("hub")}>
					{t("技能库", "Skill hub")}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "git"}
					className={`skills-tab${tab === "git" ? " skills-tab-on" : ""}`}
					onClick={() => onTab("git")}
				>
					{t("Git 仓库", "Git repo")}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "manual"}
					className={`skills-tab${tab === "manual" ? " skills-tab-on" : ""}`}
					onClick={() => onTab("manual")}
				>
					{t("手动创建", "Create by hand")}
				</button>
			</div>

			{error !== null ? <div className="side-panel-hint side-error">{error}</div> : null}

			{tab === "git" ? (
				<>
					<label className="skills-label" htmlFor="skill-repo-url">
						{t("Git 仓库地址", "Git repo URL")}
					</label>
					<div className="skills-row">
						<input
							id="skill-repo-url"
							className="skills-input mono"
							value={repoUrl}
							placeholder={t(
								"https://github.com/anthropics/skills 或 git@github.com:user/repo.git",
								"https://github.com/anthropics/skills or git@github.com:user/repo.git",
							)}
							onChange={(event) => {
								setRepoUrl(event.target.value);
								setRepoSkills(null);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter" && repoUrl.trim() !== "") void listRepo();
							}}
						/>
						<button
							type="button"
							className="btn btn-tiny"
							disabled={busy !== null || repoUrl.trim() === ""}
							onClick={() => void listRepo()}
						>
							{busy === "list" ? t("克隆中…", "Cloning…") : t("拉取列表", "Fetch the list")}
						</button>
					</div>
					<span className="side-panel-hint">
						会把仓库浅克隆一份（<code>--depth 1</code>
						{t("）到临时目录，列出根目录与")} <code>skills/</code> 下带 <code>SKILL.md</code>{" "}
						{t("的目录，装完即删。安装是")}
						<strong>{t("整目录")}</strong>复制（脚本、references 都带上）。
					</span>

					{repoSkills === null ? null : (
						<div className="skills-repo-list">
							<span className="skills-label">
								{t("仓库里有", "The repo has")} {repoSkills.length} {t("个技能", "skills")}
							</span>
							{repoSkills.map((skill) => (
								<div className="skills-repo-row" key={skill}>
									<span className="skill-slug mono">{skill}</span>
									<span className="topbar-spacer" />
									<button
										type="button"
										className="btn btn-tiny"
										disabled={busy !== null}
										onClick={() => void installFromRepo(skill)}
										title={t(`装到 ${root}/${skill}`, `Install into ${root}/${skill}`)}
									>
										{busy === skill ? t("安装中…", "Installing…") : t("安装", "Install")}
									</button>
								</div>
							))}
						</div>
					)}
				</>
			) : (
				<>
					<label className="skills-label" htmlFor="skill-manual-name">
						{t("技能名（目录名）", "Skill name (folder name)")}
					</label>
					<input
						id="skill-manual-name"
						className="skills-input"
						value={name}
						placeholder="my-skill"
						onChange={(event) => setName(event.target.value)}
					/>
					<label className="skills-label" htmlFor="skill-manual-raw">
						{t("SKILL.md（可留空，留空就写一份骨架）", "SKILL.md (optional — leave empty to write a skeleton)")}
					</label>
					<textarea
						id="skill-manual-raw"
						className="skills-input skills-textarea mono"
						value={raw}
						placeholder={"---\nname: my-skill\ndescription: 什么时候用这个技能\n---\n\n# my-skill\n\n怎么做…"}
						onChange={(event) => setRaw(event.target.value)}
					/>
					<div className="skills-row">
						<button
							type="button"
							className="btn btn-tiny btn-primary-add"
							disabled={busy !== null || name.trim() === ""}
							onClick={() => void createManual()}
						>
							{busy === "create" ? t("创建中…", "Creating…") : t("创建", "Create")}
						</button>
						<span className="side-panel-count">
							{t("写到", "Written to")} {root}/&lt;name&gt;/SKILL.md
						</span>
					</div>
				</>
			)}
		</div>
	);
}
