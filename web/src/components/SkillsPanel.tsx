import { useCallback, useEffect, useRef, useState } from "react";
import {
	errorText,
	filterInstalled,
	sortedFiles,
	type InstallResponse,
	type Preview,
	type Skill,
} from "../skills-view.ts";
import { SkillDetail } from "./SkillDetail.tsx";
import { SkillsList } from "./SkillsList.tsx";
import { SkillsHub } from "./SkillsHub.tsx";
import { SkillsInstall } from "./SkillsInstall.tsx";
import { useT } from "../use-language.ts";

/**
 * 技能面板（P8 + 技能市场）：左栏「已安装」（带搜索） + 右栏「详情 / 安装」。
 *
 * 布局跟 MCP 面板对齐（左列表右详情、中间那条线可拖）：技能也有两件完全不同的事 ——
 * 「我现在有哪些、开没开」和「去哪装一个新的」，平铺在一列里越用越乱。
 *
 * 数据走 HTTP 而不是快照：这是「按需查目录」，不属于会话状态，
 * 上百个技能塞进每一帧快照只会白白变慢。
 *
 * 安装落点只有一个：`~/.agents/skills`（服务端 `skillStore.dir` 就是它），
 * 所以「装到哪」和「列表里看到哪」永远是同一个目录。
 */

type Pane = { kind: "detail" } | { kind: "install"; tab: "hub" | "git" | "manual" };

const WIDTH_KEY = "agent-web:skills-list-width";

export function SkillsPanel() {
	const t = useT();
	const [skills, setSkills] = useState<Skill[] | null>(null);
	const [root, setRoot] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [query, setQuery] = useState("");
	/** 左栏的三个页签：全部 / 启用 / 禁用（搜索是在**当前页签**里搜） */
	const [tab, setTab] = useState<"all" | "enabled" | "disabled">("all");
	/** 多选模式：勾上之后左边出现复选框，底部换成批量操作 */
	const [selecting, setSelecting] = useState(false);
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<string | null>(null);
	const [pane, setPane] = useState<Pane>({
		kind: "detail",
	});
	const [detail, setDetail] = useState<{ path: string; preview: Preview | null } | null>(null);
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
	const [listWidth, setListWidth] = useState(() => {
		const stored = Number(localStorage.getItem(WIDTH_KEY));
		return Number.isFinite(stored) && stored >= 180 && stored <= 520 ? stored : 260;
	});

	useEffect(() => {
		localStorage.setItem(WIDTH_KEY, String(listWidth));
	}, [listWidth]);

	const resizing = useRef(false);
	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		resizing.current = true;
		const startX = event.clientX;
		const startWidth = listWidth;
		const onMove = (moveEvent: PointerEvent) => {
			if (!resizing.current) return;
			setListWidth(Math.min(520, Math.max(180, startWidth + (moveEvent.clientX - startX))));
		};
		const onUp = () => {
			resizing.current = false;
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	};

	const apply = useCallback((body: { skills?: Skill[] }) => {
		if (body.skills) setSkills(body.skills);
	}, []);

	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/skills");
			const body = (await response.json()) as { skills?: Skill[]; root?: string; error?: { message?: string } };
			if (!response.ok) {
				setError(errorText(body, response.status));
				return;
			}
			setSkills(body.skills ?? []);
			if (body.root !== undefined) setRoot(body.root);
			setError(null);
			// 一进来就把第一个技能打开：空着的右栏什么都说明不了，而「有哪些文件」才是这一栏的价值
			setSelected((current) => {
				if (current !== null) return current;
				const first = body.skills?.[0];
				if (first !== undefined) void openFile(first, sortedFiles(first.files)[0] ?? "SKILL.md");
				return first?.id ?? null;
			});
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	/** 安装 / 删除 / 启停之后统一从接口拿新列表（服务端已经回了一份，直接用） */
	const onInstalled = (result: InstallResponse) => {
		apply(result);
		if (result.notice !== undefined) {
			setNotice(result.notice);
			setError(null);
			const added = result.skills?.find((skill) => !skills?.some((item) => item.id === skill.id));
			if (added) {
				// 装完直接把它打开、并自动看一眼 SKILL.md：用户下一步就是想确认装进来的是什么
				setSelected(added.id);
				setPane({ kind: "detail" });
				void openFile(added, sortedFiles(added.files)[0] ?? "SKILL.md");
			}
		}
		if (result.installError !== undefined) setError(result.installError);
	};

	const setEnabled = async (ids: string[], enabled: boolean) => {
		if (ids.length === 0) return;
		setBusy(true);
		try {
			const response = await fetch("/api/skills/enabled", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ids, enabled }),
			});
			const body = (await response.json()) as { skills?: Skill[]; errors?: string[]; error?: { message?: string } };
			if (!response.ok) setError(body.error?.message ?? `HTTP ${response.status}`);
			else if ((body.errors ?? []).length > 0) setError((body.errors ?? []).join("；"));
			apply(body);
			// 批量做完就把勾选清掉：留着会让下一眼以为「这两个还没处理」
			setPicked(new Set());
			setNotice(enabled ? "已启用" : "已停用");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	/** 批量删除：一个接口循环删，返回删掉几个（两步确认在按钮上） */
	const removeMany = async (ids: string[]) => {
		if (ids.length === 0) return;
		setBusy(true);
		try {
			const response = await fetch("/api/skills/remove", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ids }),
			});
			const body = (await response.json()) as InstallResponse & { removeError?: string };
			apply(body);
			if (body.notice !== undefined) {
				setNotice(body.notice);
				setPicked(new Set());
				if (body.skills !== undefined) {
					setSelected(body.skills[0]?.id ?? null);
					setDetail(null);
				}
			}
			if (body.removeError !== undefined) setError(body.removeError);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
			setConfirmRemove(null);
		}
	};

	const remove = async (id: string) => {
		setBusy(true);
		try {
			const response = await fetch("/api/skills/remove", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id }),
			});
			const body = (await response.json()) as InstallResponse & { removeError?: string };
			apply(body);
			if (body.notice !== undefined) {
				setNotice(body.notice);
				if (body.skills !== undefined) setSelected(body.skills[0]?.id ?? null);
				setDetail(null);
			}
			if (body.removeError !== undefined) setError(body.removeError);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
			setConfirmRemove(null);
		}
	};

	const openFile = async (skill: Skill, path: string) => {
		setDetail({ path, preview: null });
		const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}/file?path=${encodeURIComponent(path)}`);
		const body = (await response.json()) as Preview & { error?: { message?: string } };
		setDetail({
			path,
			preview: response.ok
				? { text: body.text ?? "", bytes: body.bytes ?? 0, binary: body.binary === true }
				: { text: body.error?.message ?? "读取失败", bytes: 0, binary: false },
		});
	};

	if (skills === null) {
		return (
			<div className="skills">
				{error !== null ? (
					<div className="side-panel-hint side-error">
						{t("读不到技能目录：", "Cannot read the skills folder: ")}
						{error}
					</div>
				) : (
					<div className="side-panel-hint">{t("正在读取技能目录…", "Reading the skills folder…")}</div>
				)}
			</div>
		);
	}

	// 两步过滤：页签（全部/启用/禁用）先说「看哪一类」，搜索只在这一类里找 ——
	// 「在启用列表里搜 x」和「在所有技能里搜 x」是两件事，不能混
	const byTab = skills.filter((skill) => tab === "all" || (tab === "enabled" ? skill.enabled : !skill.enabled));
	const shown = filterInstalled(byTab, query);
	const current = skills.find((skill) => skill.id === selected) ?? null;
	const enabled = skills.filter((skill) => skill.enabled).length;

	return (
		<div className="skills">
			<div className="skills-shell" style={{ "--skills-list-width": `${listWidth}px` } as React.CSSProperties}>
				<SkillsList
					skills={skills}
					tab={tab}
					onTab={(next) => {
						// 换页签就清空勾选：看不见的条目被勾着，接着点「批量删除」很吓人
						setTab(next);
						setPicked(new Set());
					}}
					query={query}
					onQuery={setQuery}
					byTab={byTab}
					shown={shown}
					selected={selected}
					selecting={selecting}
					picked={picked}
					onPicked={setPicked}
					onSelecting={(next) => {
						setSelecting(next);
						setPicked(new Set());
					}}
					busy={busy}
					confirmRemove={confirmRemove}
					installOpen={pane.kind === "install"}
					onOpenInstall={() => setPane(pane.kind === "install" ? { kind: "detail" } : { kind: "install", tab: "hub" })}
					onOpenDetail={(skill) => {
						setSelected(skill.id);
						setPane({ kind: "detail" });
						void openFile(skill, sortedFiles(skill.files)[0] ?? "SKILL.md");
					}}
					onBatchEnabled={(enabled) => void setEnabled([...picked], enabled)}
					onBatchRemove={() => (confirmRemove === "batch" ? void removeMany([...picked]) : setConfirmRemove("batch"))}
					onEnableAll={() =>
						void setEnabled(
							byTab.filter((skill) => !skill.enabled).map((skill) => skill.id),
							true,
						)
					}
				/>

				<div
					className="skills-list-resizer"
					role="separator"
					aria-orientation="vertical"
					aria-label={t("调整技能列表宽度", "Resize the skills list")}
					title={t("左右拖动调整列表宽度（双击复位）", "Drag to resize the list (double-click to reset)")}
					onPointerDown={startResize}
					onDoubleClick={() => setListWidth(260)}
				/>

				<div className={`skills-detail${pane.kind === "detail" ? "" : " skills-detail-pane"}`}>
					{pane.kind === "install" && pane.tab === "hub" ? (
						<>
							<div className="skills-tabs" role="tablist" aria-label={t("安装方式", "Install method")}>
								<button type="button" role="tab" aria-selected className="skills-tab skills-tab-on">
									{t("技能库", "Skill hub")}
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={false}
									className="skills-tab"
									onClick={() => setPane({ kind: "install", tab: "git" })}
								>
									{t("Git 仓库", "Git repo")}
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={false}
									className="skills-tab"
									onClick={() => setPane({ kind: "install", tab: "manual" })}
								>
									{t("手动创建", "Create by hand")}
								</button>
							</div>
							<SkillsHub
								root={root}
								onInstalled={onInstalled}
								onOpenGit={() => setPane({ kind: "install", tab: "git" })}
							/>
						</>
					) : pane.kind === "install" ? (
						<SkillsInstall
							root={root}
							tab={pane.tab === "manual" ? "manual" : "git"}
							onTab={(tab) => setPane({ kind: "install", tab })}
							onInstalled={onInstalled}
						/>
					) : current === null ? (
						<div className="side-panel-hint">
							{t(
								"左边挑一个技能，或者点「＋ 安装技能」去技能库装。",
								"Pick a skill on the left, or use “+ Install skill” to browse the hub.",
							)}
						</div>
					) : (
						<SkillDetail
							skill={current}
							detail={detail}
							busy={busy}
							confirmRemove={confirmRemove}
							onFile={(path) => void openFile(current, path)}
							onToggle={() => void setEnabled([current.id], !current.enabled)}
							onRemove={() => (confirmRemove === current.id ? void remove(current.id) : setConfirmRemove(current.id))}
						/>
					)}
				</div>
			</div>

			<div className="skills-bar">
				<span className="side-panel-count">
					{t("已安装", "Installed")} {skills.length} {t("个", "")} · {t("已启用", "enabled")} {enabled} ·{" "}
					{t("目录", "folder")} <code>{root}</code>
				</span>
				<span className="topbar-spacer" />
				<button type="button" className="btn btn-tiny" disabled={busy} onClick={() => void load()}>
					{t("刷新", "Refresh")}
				</button>
			</div>

			{error !== null ? <div className="side-panel-hint side-error">{error}</div> : null}
			{notice !== null ? <div className="side-panel-hint">{notice}</div> : null}
		</div>
	);
}
