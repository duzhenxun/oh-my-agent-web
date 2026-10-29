import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onThemeChange } from "../theme.ts";

/**
 * mermaid 图渲染（ADR-0029）。
 *
 * 四条硬约束：
 *   1. **懒加载**：只有真的遇到 ```mermaid 块才 import mermaid（~500KB，绝不进首屏）；
 *   2. **失败回落**：加载/解析失败 → 显示源码 + 一行错误，不让整段 markdown 崩掉；
 *   3. **幂等**：同一段源码只渲染一次（re-render 不重跑解析）；
 *   4. **跟主题走**：配色全部从 base.css 的 CSS 变量派生，不在这里存第二份色板。
 *
 * 关于第 4 条（踩过的坑）：早先这里抄了一套 GitHub **深色**值
 * （`primaryTextColor: #e6edf3` + 半透明蓝填充 `#1f6feb33`），可整站是白底浅色，
 * 半透明蓝叠到白底上就是淡蓝色块，再配近白色文字 —— 节点基本读不出来，
 * 边标签（exposes/domain/uses）是紫底紫字，同样糊。浅色底必须用「淡填充 + 深文字」。
 *
 * 顺带修掉的两个显示问题：
 *   - `htmlLabels: false`：节点标签改用 SVG `<text>`，宽度由自己量，长路径名
 *     （`server/http/router.go`、`dao/cache_permission.go`）不再被 foreignObject 截断；
 *   - 大图不再无限等比缩小：缩到 80% 以下就停下，改成横向滚动，字还看得清。
 */
import { useT } from "../use-language.ts";
let initialized = false;

/** 整站字体（和 base.css 的 font 一致，mermaid 的 SVG 文本不吃 CSS 继承，得显式给） */
const APP_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/** 图比容器宽时最多缩到多少；再小就横向滚动（14px → 11px 是还能读的下限） */
const MIN_SCALE = 0.8;

type Palette = {
	/** 亮/暗：mermaid 的 darkMode 开关和色板推导都要用（见 theme.ts 的 data-theme-mode） */
	mode: "light" | "dark";
	bg: string;
	elev: string;
	elev2: string;
	border: string;
	borderStrong: string;
	text: string;
	textDim: string;
	accent: string;
	green: string;
	amber: string;
};

function readPalette(): Palette {
	const cs = getComputedStyle(document.documentElement);
	const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
	const mode = document.documentElement.getAttribute("data-theme-mode") === "dark" ? "dark" : "light";
	return {
		mode,
		bg: v("--bg", "#ffffff"),
		elev: v("--bg-elev", "#f7f8fa"),
		elev2: v("--bg-elev-2", "#eef1f5"),
		border: v("--border", "#e2e6ec"),
		borderStrong: v("--border-strong", "#cfd6df"),
		text: v("--text", "#1b2530"),
		textDim: v("--text-dim", "#4a5a6a"),
		accent: v("--accent", "#1f6feb"),
		green: v("--green", "#1a7f37"),
		amber: v("--amber", "#b06a00"),
	};
}

type Rgb = [number, number, number];

function parseHex(color: string): Rgb | null {
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
	if (!m) return null;
	const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** 按比例混色：t=0 → a，t=1 → b。非 hex（如 color-mix 字符串）就当没法算，直接用 b。 */
function mix(a: string, b: string, t: number): string {
	const ca = parseHex(a);
	const cb = parseHex(b);
	if (!ca || !cb) return b;
	const ch = (i: number) => Math.round(ca[i] + (cb[i] - ca[i]) * t);
	const hex = (n: number) => n.toString(16).padStart(2, "0");
	return `#${hex(ch(0))}${hex(ch(1))}${hex(ch(2))}`;
}

/**
 * mermaid 的 base 主题色板。两条原则：
 *   - 填充色 = 主色淡到 8%~14% 混白，文字一律用 --text（深色），保证对比度；
 *   - 线/边框要比填充明显，否则白底上箭头几乎看不见。
 */
function buildThemeVariables(p: Palette) {
	const nodeFill = mix(p.accent, p.bg, 0.88); // 主色 12%
	const nodeFill2 = mix(p.green, p.bg, 0.88);
	const nodeFill3 = mix(p.amber, p.bg, 0.86);
	return {
		darkMode: p.mode === "dark",
		fontFamily: APP_FONT,
		fontSize: "14px",

		background: p.bg,
		/* 通用文字 / 线 */
		textColor: p.text,
		labelColor: p.text,
		titleColor: p.text,
		lineColor: p.textDim,
		defaultLinkColor: p.textDim,
		/* 主色（flowchart 节点、大多数图的默认色） */
		primaryColor: nodeFill,
		primaryTextColor: p.text,
		primaryBorderColor: p.accent,
		mainBkg: nodeFill,
		nodeBorder: p.accent,
		nodeTextColor: p.text,
		/* 次级 / 三级：给 subgraph、分支色用 */
		secondaryColor: nodeFill2,
		secondaryTextColor: p.text,
		secondaryBorderColor: p.green,
		tertiaryColor: nodeFill3,
		tertiaryTextColor: p.text,
		tertiaryBorderColor: p.amber,
		/* 分组框、边标签（边标签原来是紫底紫字，白底上完全糊） */
		clusterBkg: p.elev,
		clusterBorder: p.borderStrong,
		edgeLabelBackground: p.elev2,
		labelBackground: p.elev2,
		noteBkgColor: nodeFill3,
		noteTextColor: p.text,
		noteBorderColor: p.amber,
		errorBkgColor: mix(p.border, p.bg, 0.5),
		errorTextColor: p.text,
		/* 时序图 */
		actorBkg: nodeFill,
		actorBorder: p.accent,
		actorTextColor: p.text,
		actorLineColor: p.borderStrong,
		signalColor: p.textDim,
		signalTextColor: p.text,
		labelBoxBkgColor: p.elev2,
		labelBoxBorderColor: p.borderStrong,
		labelTextColor: p.text,
		loopTextColor: p.text,
		activationBkgColor: mix(p.accent, p.bg, 0.78),
		activationBorderColor: p.accent,
		sequenceNumberColor: p.bg,
		/* 类图 */
		classText: p.text,
	};
}

export function MermaidDiagram({ code }: { code: string }) {
	const t = useT();
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showSource, setShowSource] = useState(false);
	const [epoch, setEpoch] = useState(0); // 配色变了（系统深浅色切换）就重渲染一次
	const renderedRef = useRef<string>("");
	const boxRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		// 主题一换，mermaid 的色板就得重算（它只在 initialize 时读一次 CSS 变量）：
		// 把 initialized 打回 false + 清掉幂等标记，下一次 render 会用新色板重画。
		return onThemeChange(() => {
			initialized = false;
			renderedRef.current = "";
			setEpoch((n) => n + 1);
		});
	}, []);

	useEffect(() => {
		if (renderedRef.current === code) return; // 幂等：同一段源码不重复渲染
		let cancelled = false;
		void (async () => {
			try {
				const { default: mermaid } = await import("mermaid");
				if (!initialized) {
					const palette = readPalette();
					mermaid.initialize({
						startOnLoad: false,
						securityLevel: "strict",
						theme: "base",
						themeVariables: buildThemeVariables(palette),
						// base 主题下的小补丁：边标签底色/字色、节点圆角（默认太圆，白底上像按钮）
						themeCSS: `
							.edgeLabel, .edgeLabel p, .edgeLabel span { color: ${palette.text}; fill: ${palette.text}; }
							.edgeLabel rect, .edgeLabel .labelBkg { fill: ${palette.elev2}; opacity: 1; }
							.nodeLabel, .label { color: ${palette.text}; }
							/* 去掉默认的投影（白底上像脏污），边框略收窄，贴近整站扁平风 */
							.node rect, .node polygon, .node circle, .node ellipse, .node path,
							.cluster rect, .label-container { filter: none; rx: 6px; ry: 6px; }
						`,
						flowchart: {
							// SVG 文本（不走 foreignObject）：自己量宽度，长文件名不再被截断
							htmlLabels: false,
							useMaxWidth: true,
							nodeSpacing: 34,
							rankSpacing: 46,
							padding: 8,
							wrappingWidth: 220,
						},
						sequence: { useMaxWidth: true },
						gantt: { useMaxWidth: true },
					});
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
	}, [code, epoch]);

	const showGraph = svg !== null && !showSource && error === null;

	// 尺寸适配：能装下按原尺寸（不放大），装不下先等比缩到容器宽；
	// 但缩到 MIN_SCALE 就停手，改成横向滚动 —— 否则「一图技术图谱」这种大图会缩成 5px 字。
	useLayoutEffect(() => {
		if (!svg || !showGraph) return;
		const box = boxRef.current;
		const el = box?.querySelector("svg");
		if (!box || !el) return;
		const natural = el.viewBox?.baseVal?.width ?? 0;
		if (!natural) return;
		el.style.maxWidth = "none";
		const fit = () => {
			const cs = getComputedStyle(box);
			const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
			const avail = Math.max(0, box.clientWidth - pad);
			if (avail <= 0) return;
			let width = Math.min(natural, avail);
			if (width < natural * MIN_SCALE) width = Math.round(natural * MIN_SCALE);
			el.style.width = `${Math.round(width)}px`;
			el.style.height = "auto";
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(box);
		return () => ro.disconnect();
	}, [svg, showGraph]);

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
				<div className="mermaid-svg" ref={boxRef} dangerouslySetInnerHTML={{ __html: svg ?? "" }} />
			) : (
				<pre className="mermaid-source mono">{code}</pre>
			)}
			{error ? (
				<div className="mermaid-error">
					{t("渲染失败：", "Render failed: ")}
					{error}
				</div>
			) : null}
		</div>
	);
}
