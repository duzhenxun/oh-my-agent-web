import { useEffect, useState } from "react";
import type { ProviderView } from "../types.ts";
import { useT } from "../use-language.ts";

type RemoteModel = { id: string; ownedBy: string | null; imported: boolean };

/**
 * 导入模型（ADR-0026 B 期）：拉远端清单 → 复选框 → 批量导入。
 *
 * 三个约束：
 *   - **不自动全选**：一个网关挂 200 个模型是常态，全导会把选择器淹掉；
 *   - 已导入的置灰并标「已导入」，重复勾也不会写两遍（服务端只追加不存在的）；
 *   - 拉到清单失败时给出可操作的原因，并保留「手动填 id」的通路（provider 表单里）。
 */
export function ImportModels({
	provider,
	onClose,
	onImported,
}: {
	provider: ProviderView;
	onClose: () => void;
	onImported: () => void;
}) {
	const t = useT();
	const [models, setModels] = useState<RemoteModel[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void (async () => {
			try {
				const response = await fetch(`/api/providers/${encodeURIComponent(provider.provider)}/remote-models`);
				const body = (await response.json()) as { models?: RemoteModel[]; error?: { message?: string } };
				if (!response.ok) {
					setError(body.error?.message ?? `HTTP ${response.status}`);
					setModels([]);
					return;
				}
				setModels(body.models ?? []);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
				setModels([]);
			}
		})();
	}, [provider.provider]);

	const visible = (models ?? []).filter(
		(model) => filter.trim() === "" || model.id.toLowerCase().includes(filter.trim().toLowerCase()),
	);
	const importable = visible.filter((model) => !model.imported);

	const doImport = async () => {
		if (selected.size === 0) return;
		setBusy(true);
		try {
			const response = await fetch(`/api/providers/${encodeURIComponent(provider.provider)}/import`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ids: [...selected] }),
			});
			const body = (await response.json()) as { added?: string[]; error?: { message?: string } };
			if (!response.ok) setError(body.error?.message ?? `HTTP ${response.status}`);
			else {
				onImported();
				onClose();
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="side-panel import-models">
			<div className="side-panel-head">
				<strong>{t("导入模型")}</strong>
				<span className="side-panel-count mono">{provider.provider}</span>
				<span className="topbar-spacer" />
				<button type="button" className="btn btn-tiny" onClick={onClose}>
					关闭
				</button>
			</div>

			{models === null ? <div className="side-panel-hint">{t("正在读取远端模型清单…")}</div> : null}
			{error ? (
				<div className="side-panel-hint side-error">
					{t("读取失败：", "Failed to load: ")}
					{error}
				</div>
			) : null}

			{models !== null ? (
				<>
					<input
						className="side-field input"
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
						placeholder={t("筛选模型 id…")}
					/>
					<div className="import-list">
						{visible.length === 0 ? <div className="side-panel-hint">{t("没有可导入的模型")}</div> : null}
						{visible.map((model) => (
							<label className={`import-row${model.imported ? " import-row-done" : ""}`} key={model.id}>
								<input
									type="checkbox"
									disabled={model.imported}
									checked={model.imported || selected.has(model.id)}
									onChange={() =>
										setSelected((current) => {
											const next = new Set(current);
											if (next.has(model.id)) next.delete(model.id);
											else next.add(model.id);
											return next;
										})
									}
								/>
								<span className="import-id mono">{model.id}</span>
								{model.imported ? <span className="side-panel-count">{t("已导入")}</span> : null}
							</label>
						))}
					</div>
					<div className="import-foot">
						<button
							type="button"
							className="btn btn-tiny"
							onClick={() => setSelected(new Set(importable.map((model) => model.id)))}
							disabled={importable.length === 0}
						>
							全选可导入（{importable.length}）
						</button>
						<button
							type="button"
							className="btn btn-tiny"
							onClick={() => setSelected(new Set())}
							disabled={selected.size === 0}
						>
							清除选择
						</button>
						<span className="topbar-spacer" />
						<button
							type="button"
							className="btn btn-tiny"
							onClick={() => void doImport()}
							disabled={busy || selected.size === 0}
						>
							导入 {selected.size} 个
						</button>
					</div>
				</>
			) : null}
		</div>
	);
}
