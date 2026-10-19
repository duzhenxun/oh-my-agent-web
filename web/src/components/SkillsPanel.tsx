import { useEffect, useState } from "react";

type Skill = { id: string; name: string; description: string; enabled: boolean; files: string[] };
type Preview = { text: string; bytes: number; binary: boolean };

/**
 * 技能面板（P8）：列出技能目录 → 批量启停 → 点开看内容（SKILL.md 与脚本）。
 *
 * 数据走 HTTP 而不是快照：这是"按需查目录"，不属于会话状态，
 * 76 个技能塞进每一帧快照只会白白变慢。
 */
export function SkillsPanel() {
	const [skills, setSkills] = useState<Skill[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [detail, setDetail] = useState<{ skill: Skill; path: string; preview: Preview | null } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = async () => {
		try {
			const response = await fetch("/api/skills");
			const body = (await response.json()) as { skills?: Skill[]; error?: { message?: string } };
			if (!response.ok) {
				setError(body.error?.message ?? `HTTP ${response.status}`);
				return;
			}
			setSkills(body.skills ?? []);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	useEffect(() => {
		void load();
	}, []);

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
			setSkills(body.skills ?? (await (await fetch("/api/skills")).json()).skills ?? []);
			setSelected(new Set());
		} finally {
			setBusy(false);
		}
	};

	const openFile = async (skill: Skill, path: string) => {
		setDetail({ skill, path, preview: null });
		const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}/file?path=${encodeURIComponent(path)}`);
		const body = (await response.json()) as Preview & { error?: { message?: string } };
		setDetail({
			skill,
			path,
			preview: response.ok
				? { text: body.text ?? "", bytes: body.bytes ?? 0, binary: body.binary === true }
				: { text: body.error?.message ?? "读取失败", bytes: 0, binary: false },
		});
	};

	if (skills === null) return <div className="side-panel-hint">正在读取技能目录…</div>;

	const toggle = (id: string) => {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<div className="skills">
			<div className="skills-bar">
				<span className="side-panel-count">
					{skills.length} 个技能 · 已启用 {skills.filter((skill) => skill.enabled).length} · 已选 {selected.size}
				</span>
				<span className="topbar-spacer" />
				<button
					type="button"
					className="btn btn-tiny"
					disabled={busy || selected.size === 0}
					onClick={() => void setEnabled([...selected], true)}
				>
					启用选中
				</button>
				<button
					type="button"
					className="btn btn-tiny"
					disabled={busy || selected.size === 0}
					onClick={() => void setEnabled([...selected], false)}
				>
					禁用选中
				</button>
				<button
					type="button"
					className="btn btn-tiny"
					disabled={busy}
					onClick={() =>
						void setEnabled(
							skills.filter((skill) => !skill.enabled).map((skill) => skill.id),
							true,
						)
					}
				>
					全部启用
				</button>
				<button
					type="button"
					className="btn btn-tiny"
					disabled={busy}
					onClick={() =>
						void setEnabled(
							skills.filter((skill) => skill.enabled).map((skill) => skill.id),
							false,
						)
					}
				>
					全部禁用
				</button>
			</div>
			{error ? <div className="side-panel-hint side-error">{error}</div> : null}

			<div className="skills-body">
				<div className="skills-list">
					{skills.map((skill) => (
						<div className={`skill-row${skill.enabled ? "" : " skill-row-off"}`} key={skill.id}>
							<input
								type="checkbox"
								checked={selected.has(skill.id)}
								onChange={() => toggle(skill.id)}
								aria-label={`选择 ${skill.name}`}
							/>
							<button
								type="button"
								className="skill-main"
								onClick={() => void openFile(skill, "SKILL.md")}
								title={skill.description}
							>
								<span className="skill-name">{skill.name}</span>
								<span className="skill-desc">{skill.description}</span>
							</button>
							<span className={`skill-state${skill.enabled ? " skill-state-on" : ""}`}>
								{skill.enabled ? "启用" : "已禁用"}
							</span>
						</div>
					))}
				</div>

				{detail ? (
					<div className="skill-detail">
						<div className="skill-detail-head">
							<strong>{detail.skill.name}</strong>
							<span className="side-panel-count mono">{detail.path}</span>
							<button type="button" className="btn btn-tiny" onClick={() => setDetail(null)}>
								关闭
							</button>
						</div>
						<div className="skill-files">
							{detail.skill.files.map((file) => (
								<button
									type="button"
									key={file}
									className={`skill-file${file === detail.path ? " skill-file-on" : ""}`}
									onClick={() => void openFile(detail.skill, file)}
								>
									{file}
								</button>
							))}
						</div>
						{detail.preview === null ? (
							<div className="side-panel-hint">读取中…</div>
						) : detail.preview.binary ? (
							<div className="side-panel-hint">这是二进制文件，不能预览</div>
						) : (
							<pre className="skill-preview mono">{detail.preview.text}</pre>
						)}
					</div>
				) : null}
			</div>
		</div>
	);
}
