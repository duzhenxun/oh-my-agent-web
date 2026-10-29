import type { Components } from "react-markdown";
import { memo, useCallback, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { imageSrcOf, languageLabelOf } from "../markdown-media.ts";
import { openImageViewer } from "../image-viewer.ts";
import { logicalWidthOf } from "../image-display.ts";
import { useStoredNumber } from "../use-stored-number.ts";
import { CHAT_IMAGE_WIDTH_DEFAULT, CHAT_IMAGE_WIDTH_KEY } from "../ui-prefs.ts";
import { MermaidDiagram } from "./MermaidDiagram.tsx";
import { tNow } from "../use-language.ts";
import { looksLikePath, looksLikePathListing, openPathFromMessage, pathTokens } from "../path-tokens.ts";

/**
 * markdown 渲染（ADR-0008 §Markdown 安全渲染）。
 *  - `skipHtml`：模型输出里的原始 HTML 一律当文本，杜绝 `<script>`/`onerror` 之类；
 *  - 链接只放行 http(s)，且一律新窗口 + noopener；
 *  - 图片：远程图 / 已上传图 / **工作区里的图片文件**（走 /api/files/raw，受项目约束），
 *    点击在**原地弹预览浮层**（不开新标签页，见 image-viewer.ts）；
 *  - 代码块：`rehype-highlight` 上色 + 显示语言标签（配色见 styles/highlight.css）。
 *
 * 外面包 `memo`：markdown 解析 + 语法高亮是前端最贵的一件事。文本没变就不重解析 ——
 * 快照每次都是新对象，但正文的字符串没变，这一层挡住了绝大部分重算。
 */
/**
 * 消息里的图：**宽度上限 = min(逻辑尺寸, 用户设的上限)**。
 *
 * 两道收：
 *   1. 设备像素比（`logicalWidthOf`）：2x 截图别显示成两倍大；
 *   2. 用户设的上限（`CHAT_IMAGE_WIDTH_KEY`，默认 400px）：别占满整条气泡。
 * 两个都是「上限」不是「尺寸」：小图不会被拉大；要看清楚就点开（图片查看器给原图）。
 *
 * 为什么用 effect + onLoad 两条路：图可能命中缓存、在挂载前就 load 完（`onLoad` 不一定会触发），
 * 这时靠 effect 读 `complete + naturalWidth` 补一次；反之冷加载就靠 `onLoad`。
 */
function MarkdownImage({ src, alt }: { src: string; alt: string }) {
	const [cap] = useStoredNumber(CHAT_IMAGE_WIDTH_KEY, CHAT_IMAGE_WIDTH_DEFAULT, 0, 4000);
	const ref = useRef<HTMLImageElement | null>(null);
	const apply = useCallback(() => {
		const image = ref.current;
		if (!image || !image.complete || image.naturalWidth === 0) return;
		const logical = logicalWidthOf(image.naturalWidth, window.devicePixelRatio || 1, src);
		const limit = cap > 0 ? cap : null;
		const width = logical === null ? limit : limit === null ? logical : Math.min(logical, limit);
		image.style.maxWidth = width === null ? "" : `${width}px`;
	}, [cap, src]);
	useEffect(apply, [apply]);
	return <img ref={ref} className="md-img" src={src} alt={alt} loading="lazy" onLoad={apply} />;
}

const components: Components = {
	a: ({ href, children }) => {
		const safe = typeof href === "string" && /^https?:\/\//i.test(href);
		return (
			<a href={safe ? href : undefined} target="_blank" rel="noopener noreferrer" className="md-link">
				{children}
			</a>
		);
	},
	img: ({ src, alt }) => {
		const resolved = typeof src === "string" ? imageSrcOf(src) : null;
		if (!resolved)
			return (
				<span className="md-img-blocked">
					{tNow("图片已拦截", "Image blocked")} {alt ?? ""}
				</span>
			);
		// 点图不跳新标签页：原地弹预览浮层（Esc / 点空白关闭）
		return (
			<button
				type="button"
				className="md-img-btn"
				title={tNow("点击放大预览", "Click to preview")}
				onClick={() => openImageViewer(resolved, alt ?? "")}
			>
				<MarkdownImage src={resolved} alt={alt ?? ""} />
			</button>
		);
	},
	pre: ({ children, ...rest }) => {
		// 代码块顶部加一行语言标签（React 的 pre 上拿不到子节点的 className，交给 code 处理）
		return (
			<div className="md-pre">
				<pre {...rest}>{children}</pre>
			</div>
		);
	},
	code: ({ className, children, ...rest }) => {
		const language = languageLabelOf(className);
		const text = String(children).replace(/\n$/, "");
		// mermaid 走专门组件（懒加载 + 失败回落），不当普通代码块
		if (language === "mermaid") return <MermaidDiagram code={text} />;
		const isBlock = language !== "" || (typeof children === "string" && children.includes("\n"));
		if (!isBlock) {
			// 行内代码整段就是个路径（`docs/report.html`）→ 点它直接在右侧预览
			if (looksLikePath(text)) {
				return (
					<button
						type="button"
						className="md-path"
						title={tNow("在右侧预览这个文件", "Preview this file on the right")}
						onClick={() => openPathFromMessage(text.trim())}
					>
						{children}
					</button>
				);
			}
			return (
				<code className={className} {...rest}>
					{children}
				</code>
			);
		}
		// 路径清单（报告产物 / 目录树）：逐行渲染，把路径变成可点的按钮。
		// 代价是这一块不再上色 —— 可点比好看重要，而且这类块本来也没什么语法。
		if (looksLikePathListing(text)) {
			return (
				<>
					{language ? <span className="md-lang">{language}</span> : null}
					<code className={`${className ?? ""} md-path-block`} {...rest}>
						{text.split("\n").map((line, index) => (
							<span className="md-path-line" key={index}>
								{pathTokens(line).map((part, partIndex) =>
									part.path ? (
										<button
											type="button"
											key={partIndex}
											className="md-path"
											title={tNow("在右侧预览这个文件", "Preview this file on the right")}
											onClick={() => openPathFromMessage(part.path!)}
										>
											{part.text}
										</button>
									) : (
										<span key={partIndex}>{part.text}</span>
									),
								)}
								{"\n"}
							</span>
						))}
					</code>
				</>
			);
		}
		return (
			<>
				{language ? <span className="md-lang">{language}</span> : null}
				<code className={className} {...rest}>
					{children}
				</code>
			</>
		);
	},
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="md">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
				skipHtml
				components={components}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
