import { useEffect, useRef, useState } from "react";
import { groupModels } from "../model-groups.ts";
import type { ModelOption } from "../types.ts";
import { setModel } from "../ws.ts";

/**
 * 模型选择器（P6）：点开是「筛选框 + 按厂家分组」的列表，而不是原生 select。
 *
 * 为什么不用原生 select：24 个模型里有重名（不同厂家同标签），原生 select 没法分组显示厂家，
 * 也没法筛选；用原生 `<optgroup>` 也解决不了重名辨认问题（组内同名仍然分不清）。
 */
export function ModelPicker({
	models,
	current,
	disabled,
}: {
	models: ModelOption[];
	current: string | null;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const boxRef = useRef<HTMLDivElement>(null);

	// 点外面 / 按 Esc 关掉
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent) => {
			if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const groups = groupModels(models, filter);
	const currentLabel = models.find((model) => model.id === current)?.label ?? current ?? "模型未就绪";

	return (
		<div className="model-picker" ref={boxRef}>
			<button
				type="button"
				className="tool-chip model-trigger"
				onClick={() => {
					if (disabled) return;
					setFilter("");
					setOpen((value) => !value);
				}}
				disabled={disabled}
				title={current ?? "选择模型"}
			>
				<span className="tool-icon" aria-hidden="true">
					🤖
				</span>
				<span className="model-trigger-label">{currentLabel}</span>
				<span className="model-caret" aria-hidden="true">
					▾
				</span>
			</button>

			{open ? <div className="model-sheet-backdrop" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
			{open ? (
				<div className="model-menu" role="listbox" aria-label="选择模型">
					{/* 手机上菜单是整宽的底部抽屉，需要一个明确可见的关闭入口 */}
					<button type="button" className="model-sheet-close" onClick={() => setOpen(false)} title="关闭">
						✕ 关闭
					</button>
					<input
						autoFocus
						className="model-filter"
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
						placeholder="筛选模型…"
					/>
					<div className="model-list">
						{groups.length === 0 ? <div className="model-empty">没有匹配的模型</div> : null}
						{groups.map((group) => (
							<div className="model-group" key={group.provider}>
								<div className="model-group-title">{group.provider.toUpperCase()}</div>
								{group.models.map((model) => (
									<button
										type="button"
										key={model.id}
										className={`model-item${model.id === current ? " model-item-on" : ""}`}
										onClick={() => {
											setModel(model.id);
											setOpen(false);
										}}
										title={model.id}
									>
										<span className="model-check" aria-hidden="true">
											{model.id === current ? "✓" : ""}
										</span>
										<span className="model-label">{model.label}</span>
									</button>
								))}
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}
