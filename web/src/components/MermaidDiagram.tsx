import { useEffect, useRef, useState } from "react";

/**
 * mermaid 图渲染（ADR-0029）。
 *
 * 三条硬约束：
 *   1. **懒加载**：只有真的遇到 ```mermaid 块才 import mermaid（~500KB，绝不进首屏）；
 *   2. **失败回落**：加载/解析失败 → 显示源码 + 一行错误，不让整段 markdown 崩掉；
 *   3. **幂等**：同一段源码只渲染一次（re-render 不重跑解析）。
 *
 * 安全：mermaid 用默认 `securityLevel: "strict"`，它自带的 HTML/脚本会被消毒；
 * 我们只对 `language-mermaid` 代码块走这条路，不从普通文本里嗅探图表类型。
 */
let initialized = false;

export function MermaidDiagram({ code }: { code: string }) {
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showSource, setShowSource] = useState(false);
	const renderedRef = useRef<string>("");

	useEffect(() => {
		if (renderedRef.current === code) return; // 幂等：同一段源码不重复渲染
		let cancelled = false;
		void (async () => {
			try {
				const { default: mermaid } = await import("mermaid");
				if (!initialized) {
					mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
					initialized = true;
				}
				const id = `mmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
				const { svg: rendered } = await mermaid.render(id, code);
				if (cancelled) return;
				renderedRef.current = code;
				setSvg(rendered);
				setError(null);
			} catch (cause) {
				if (cancelled) return;
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [code]);

	const showGraph = svg !== null && !showSource && error === null;

	return (
		<div className="mermaid-block">
			<div className="mermaid-head">
				<span className="mermaid-lang">mermaid</span>
				<span className="topbar-spacer" />
				<button
					type="button"
					className={`mermaid-btn${showGraph ? " mermaid-btn-on" : ""}`}
					onClick={() => setShowSource(false)}
					disabled={svg === null}
				>
					SVG
				</button>
				<button
					type="button"
					className={`mermaid-btn${!showGraph ? " mermaid-btn-on" : ""}`}
					onClick={() => setShowSource(true)}
				>
					源代码
				</button>
			</div>
			{showGraph ? (
				// 内容来自 mermaid 渲染（strict 模式下已消毒）
				<div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg ?? "" }} />
			) : (
				<pre className="mermaid-source mono">{code}</pre>
			)}
			{error ? <div className="mermaid-error">渲染失败：{error}</div> : null}
		</div>
	);
}
