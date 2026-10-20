import { useState } from "react";
import { testModel } from "../ws.ts";
import type { ProviderView } from "../types.ts";
import { removeModel, updateModel } from "../ws.ts";

type ModelSpecForm = {
	id: string;
	name: string;
	reasoning: boolean;
	imageInput: boolean;
	contextWindow: string;
	maxTokens: string;
	input: string;
	output: string;
	cacheRead: string;
	cacheWrite: string;
};

/** 从 provider 视图里取一个模型的初始表单（规格/价格拿不到就留空 —— 显示"未提供"，不写 0） */
function initialForm(provider: ProviderView, modelId: string): ModelSpecForm {
	const model = provider.models.find((item) => item.id === modelId);
	const cost = model?.cost ?? {};
	const text = (value: unknown) => (typeof value === "number" ? String(value) : "");
	return {
		id: modelId,
		name: model?.name ?? modelId,
		reasoning: model?.reasoning === true,
		imageInput: model?.imageInput === true,
		contextWindow: text(model?.contextWindow),
		maxTokens: text(model?.maxTokens),
		input: text(cost.input),
		output: text(cost.output),
		cacheRead: text(cost.cacheRead),
		cacheWrite: text(cost.cacheWrite),
	};
}

/**
 * 逐模型编辑（ADR-0026 A 期）：ID / Name / 能力 / 规格 / 价格。
 *
 * 三个刻意的细节：
 *   - 价格留空 = 未提供（界面显示"未提供"，**不写 0**——0 会被误读成免费）；
 *   - 保存后提示"重启后生效"：pi 的模型表是进程内缓存（ADR-0025 §4 尚未做热重载）；
 *   - 校验在服务端（validateModelSpec），一次列出所有问题，前端不重复实现规则。
 */
export function ModelEditor({
	provider,
	modelId,
	onClose,
}: {
	provider: ProviderView;
	modelId: string;
	onClose: () => void;
}) {
	const [form, setForm] = useState<ModelSpecForm>(() => initialForm(provider, modelId));
	const [sent, setSent] = useState(false);
	const [catalog, setCatalog] = useState<string | null>(null);
	const [testing, setTesting] = useState<string | null>(null);
	const set = <K extends keyof ModelSpecForm>(key: K, value: ModelSpecForm[K]) =>
		setForm((current) => ({ ...current, [key]: value }));

	/** 从 models.dev 预填（查不到就明确说"没查到"，不猜） */
	const fillFromCatalog = async () => {
		setCatalog(null);
		const response = await fetch(
			`/api/providers/${encodeURIComponent(provider.provider)}/catalog?model=${encodeURIComponent(form.id)}`,
		);
		const body = (await response.json()) as {
			spec?: {
				name: string;
				contextWindow: number | null;
				maxTokens: number | null;
				reasoning: boolean;
				imageInput: boolean;
				cost: Record<string, number> | null;
			};
			error?: { message?: string };
		};
		if (!response.ok || !body.spec) {
			setCatalog("models.dev 里没查到，请手动填写");
			return;
		}
		const spec = body.spec;
		setForm((current) => ({
			...current,
			name: spec.name || current.name,
			reasoning: spec.reasoning,
			imageInput: spec.imageInput,
			contextWindow: spec.contextWindow === null ? "" : String(spec.contextWindow),
			maxTokens: spec.maxTokens === null ? "" : String(spec.maxTokens),
			input: spec.cost ? String(spec.cost.input ?? "") : "",
			output: spec.cost ? String(spec.cost.output ?? "") : "",
			cacheRead: spec.cost ? String(spec.cost.cacheRead ?? "") : "",
			cacheWrite: spec.cost ? String(spec.cost.cacheWrite ?? "") : "",
		}));
		setCatalog("已填入");
	};

	const runTest = async () => {
		setTesting("测试中…");
		const result = await testModel(provider.provider, form.id);
		setTesting(
			result.ok ? `✅ 响应正常：${result.latencyMs}ms（HTTP ${result.status}）` : `❌ 没通：${result.message}`,
		);
	};

	const save = () => {
		updateModel(provider.provider, {
			id: form.id,
			name: form.name,
			reasoning: form.reasoning,
			imageInput: form.imageInput,
			contextWindow: form.contextWindow,
			maxTokens: form.maxTokens,
			cost: { input: form.input, output: form.output, cacheRead: form.cacheRead, cacheWrite: form.cacheWrite },
		});
		setSent(true);
	};

	return (
		<div className="side-panel model-editor">
			<div className="side-panel-head">
				<strong>模型</strong>
				<span className="side-panel-count mono">{provider.provider}</span>
				<span className="topbar-spacer" />
				<button type="button" className="btn btn-tiny" onClick={() => void runTest()} disabled={testing !== null}>
					测试
				</button>
				<button
					type="button"
					className="btn btn-tiny btn-danger"
					onClick={() => {
						// 只移出模型表，不动 api key：误删了重新导入即可
						if (!window.confirm(`从「${provider.provider}」移除模型 ${form.id}？`)) return;
						removeModel(provider.provider, form.id);
						onClose();
					}}
				>
					移除
				</button>
				<button type="button" className="btn btn-tiny" onClick={onClose}>
					关闭
				</button>
			</div>

			<div className="side-field-row">
				<label className="side-field">
					<span>ID（必填）</span>
					<input value={form.id} readOnly title="ID 是主键，改名等于新建一个模型" />
				</label>
				<label className="side-field">
					<span>Name</span>
					<input
						value={form.name}
						onChange={(event) => set("name", event.target.value)}
						placeholder="DeepSeek V4.1 Flash"
					/>
				</label>
			</div>

			<div className="side-field">
				<span>能力</span>
				<label className="side-check">
					<input
						type="checkbox"
						checked={form.reasoning}
						onChange={(event) => set("reasoning", event.target.checked)}
					/>
					推理 / 思考
				</label>
				<label className="side-check">
					<input
						type="checkbox"
						checked={form.imageInput}
						onChange={(event) => set("imageInput", event.target.checked)}
					/>
					图片输入
				</label>
			</div>

			<div className="side-field">
				<span>模型规格</span>
				<div className="side-field-row">
					<label className="side-field">
						<span>上下文窗口（tokens）</span>
						<input
							inputMode="numeric"
							value={form.contextWindow}
							onChange={(event) => set("contextWindow", event.target.value)}
							placeholder="1000000"
						/>
					</label>
					<label className="side-field">
						<span>最大输出 tokens</span>
						<input
							inputMode="numeric"
							value={form.maxTokens}
							onChange={(event) => set("maxTokens", event.target.value)}
							placeholder="384000"
						/>
					</label>
				</div>
			</div>

			<div className="side-field">
				<span>每百万 tokens 价格（留空 = 未提供）</span>
				<div className="side-field-row">
					<label className="side-field">
						<span>输入</span>
						<input
							inputMode="decimal"
							value={form.input}
							onChange={(event) => set("input", event.target.value)}
							placeholder="未提供"
						/>
					</label>
					<label className="side-field">
						<span>输出</span>
						<input
							inputMode="decimal"
							value={form.output}
							onChange={(event) => set("output", event.target.value)}
							placeholder="未提供"
						/>
					</label>
					<label className="side-field">
						<span>缓存读</span>
						<input
							inputMode="decimal"
							value={form.cacheRead}
							onChange={(event) => set("cacheRead", event.target.value)}
							placeholder="未提供"
						/>
					</label>
					<label className="side-field">
						<span>缓存写</span>
						<input
							inputMode="decimal"
							value={form.cacheWrite}
							onChange={(event) => set("cacheWrite", event.target.value)}
							placeholder="未提供"
						/>
					</label>
				</div>
			</div>

			<div className="import-foot">
				<button
					type="button"
					className="btn btn-tiny"
					title="从 models.dev 查这个模型的公开规格（只作建议值，会覆盖当前已填的规格）"
					onClick={() => void fillFromCatalog()}
				>
					填入模型信息
				</button>
			</div>
			{catalog ? (
				<div className={catalog.startsWith("已填入") ? "side-ok" : "side-panel-hint side-error"}>{catalog}</div>
			) : null}
			{testing ? (
				<div className={testing.startsWith("✅") ? "side-ok" : "side-panel-hint side-error"}>{testing}</div>
			) : null}
			{sent ? <div className="side-ok">已提交，模型表会自动热重载</div> : null}
			<button type="button" className="btn btn-tiny" onClick={save}>
				保存模型信息
			</button>
		</div>
	);
}
