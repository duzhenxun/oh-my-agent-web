/**
 * 顶栏「智能体引擎」切换（ADR-0024）。
 *
 * 一个按钮 + 一个浮层：浮层里列出注册表里的全部引擎（名字、短标签、能力说明、版本），
 * 当前那个打勾。切换会发 `set_engine`，服务端零重启换引擎 —— 项目清单、模型列表、
 * 能力矩阵都跟着换，所以这里**不做任何本地乐观状态**：等快照回来即可，避免「界面说切了、
 * 数据还是旧的」。
 *
 * 列表来自快照（`snapshot.engines`），不是再来一条接口 —— 遵守「快照是唯一事实源」。
 */
import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store.ts";
import { setEngine } from "../ws.ts";
import type { EngineOption } from "../types.ts";

function EngineIcon() {
	return (
		<svg
			className="engine-picker-icon"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.3}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<rect x="2.6" y="5.2" width="10.8" height="7.6" rx="2.3" />
			<path d="M8 5.2V3.3" />
			<circle cx="8" cy="2.4" r="0.85" fill="currentColor" stroke="none" />
			<circle cx="6" cy="9" r="0.8" fill="currentColor" stroke="none" />
			<circle cx="10" cy="9" r="0.8" fill="currentColor" stroke="none" />
		</svg>
	);
}

function Chevron() {
	return (
		<svg className="engine-picker-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
			<path d="M4.4 6.2 8 9.8l3.6-3.6" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function Check() {
	return (
		<svg className="engine-picker-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
			<path d="M3.4 8.4 6.6 11.6 12.6 4.8" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

/** 引擎版本显示：语义化版本加 v，别的前缀（如假引擎的 "fake"）原样给，不硬凑一个 "v" */
function engineVersionText(version: string | null | undefined): string {
	if (!version) return "当前";
	return /^\d/.test(version) ? `v${version}` : version;
}

export function EnginePicker() {
	const state = useAppState();
	const snapshot = state.snapshot;
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement | null>(null);

	const engines: EngineOption[] = snapshot?.engines ?? [];
	const activeName = snapshot?.engine ?? "";
	const active = engines.find((engine) => engine.name === activeName);
	const running = snapshot ? snapshot.running.status !== "idle" : false;

	// 点外面 / Esc 关掉：浮层不是模态，不该拦住任何操作
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	// 快照里没有引擎清单（老服务端 / 还没连上）：不占位置，也不要一个点不动的按钮
	if (engines.length === 0) return null;

	const label = active?.label ?? activeName;
	const badge = active?.badge ?? activeName.toUpperCase();

	return (
		<div className="engine-picker" ref={box}>
			<button
				type="button"
				className={`side-foot-btn engine-picker-btn${open ? " side-foot-btn-on" : ""}`}
				onClick={() => setOpen((value) => !value)}
				title={running ? "切换智能体引擎（回合进行中，先等它结束）" : "切换智能体引擎"}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`智能体引擎：${label}`}
			>
				<span className="side-foot-icon" aria-hidden="true">
					<EngineIcon />
				</span>
				<span className="engine-picker-badge">{badge}</span>
				<span className="engine-picker-name">{label}</span>
				<Chevron />
			</button>

			{open ? (
				<div className="engine-pop" role="listbox" aria-label="智能体引擎">
					<div className="engine-pop-head">
						<span className="engine-pop-title">智能体引擎</span>
						<span className="engine-pop-note">切换后项目与会话跟着新引擎</span>
					</div>
					{engines.map((engine) => {
						const isActive = engine.name === activeName;
						return (
							<button
								type="button"
								key={engine.name}
								role="option"
								aria-selected={isActive}
								disabled={running && !isActive}
								className={`engine-option${isActive ? " engine-option-on" : ""}`}
								onClick={() => {
									setOpen(false);
									if (!isActive) setEngine(engine.name);
								}}
								title={running && !isActive ? "回合进行中，先中断或等它结束" : undefined}
							>
								<span className="engine-option-top">
									<span className="engine-option-badge">{engine.badge}</span>
									<span className="engine-option-label">{engine.label}</span>
									{isActive ? (
										<span className="engine-option-version">
											{engineVersionText(snapshot?.versions.engine)}
										</span>
									) : null}
									<span className="engine-option-tail">{isActive ? <Check /> : null}</span>
								</span>
								{engine.description ? (
									<span className="engine-option-desc">{engine.description}</span>
								) : null}
								<span className="engine-option-caps">
									{engine.capabilities.approvals ? "审批拦截" : "自行授权"}
									{engine.capabilities.modelSwitch ? " · 模型可切" : ""}
									{engine.capabilities.thinkingLevel ? " · 思考强度" : ""}
									{engine.capabilities.resume ? " · 可续历史" : ""}
								</span>
							</button>
						);
					})}
					{running ? <div className="engine-pop-hint">有回合在跑：先中断或等结束再切</div> : null}
				</div>
			) : null}
		</div>
	);
}
