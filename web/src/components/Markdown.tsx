import type { Components } from "react-markdown";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
	decodePathOnce,
	groupImageBlocks,
	imageSrcOf,
	isImagePath,
	languageLabelOf,
	promoteImagePaths,
} from "../markdown-media.ts";
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
 *    模型只写了路径（裸路径 / 行内代码 / 本地路径链接）的，`promoteImagePaths` 先提升成图片，
 *    提升错了（文件不存在等）就回落到可点的路径，不会留下一张碎图；
 *  - 代码块：`rehype-highlight` 上色 + 显示语言标签（配色见 styles/highlight.css）。
 *
 * 外面包 `memo`：markdown 解析 + 语法高亮是前端最贵的一件事。文本没变就不重解析 ——
 * 快照每次都是新对象，但正文的字符串没变，这一层挡住了绝大部分重算。
 */
/**
 * 消息里的一张图：点一下原地放大 + 「加载不出来怎么办」。
 *
 * **宽度上限 = min(逻辑尺寸, 用户设的上限)**，两道收：
 *   1. 设备像素比（`logicalWidthOf`）：2x 截图别显示成两倍大；
 *   2. 用户设的上限（`CHAT_IMAGE_WIDTH_KEY`，默认 400px）：别占满整条气泡。
 * 两个都是「上限」不是「尺寸」：小图不会被拉大；要看清楚就点开（图片查看器给原图）。
 * 为什么 effect + onLoad 两条路：图可能命中缓存、在挂载前就 load 完（`onLoad` 不一定会触发），
 * 这时靠 effect 读 `complete + naturalWidth` 补一次；反之冷加载就靠 `onLoad`。
 *
 * 失败回落很重要：`promoteImagePaths` 是从**文本**里猜哪些路径是图（模型写「命名为 logo.png」也像），
 * 文件不存在 / 类型不在白名单（服务端 400）/ 超 20MB（413）时，`<img>` 只会碎成一个小图标 ——
 * 那种体验比原来的蓝色路径还差。所以 `onError` 一响就退回**可点的路径按钮**（点击去右侧面板打开）。
 * 回落写在这一层，而不是里面再包一个组件：外层「点击放大」本身就是 `<button>`，
 * 里面再嵌一个 `<button>` 是非法 HTML（React 会警告，点击也会被交叠掉）。
 */
function MessageImage({ src, path, alt }: { src: string; path: string; alt: string }) {
	const [cap] = useStoredNumber(CHAT_IMAGE_WIDTH_KEY, CHAT_IMAGE_WIDTH_DEFAULT, 0, 4000);
	// 记的是「哪个 src 挂了」而不是一个 boolean：流式输出时路径会先半截后完整，
	// src 一变就得重试加载，否则后半辈就一直停在“没加载出来”的路径按钮上
	const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
	const broken = brokenSrc === src;
	// 显示与「点开」都用解码后的路径：解析器给的 src 是百分号编码的（见 decodePathOnce），
	// 直接展示会变成 `%E6%98%A0…`，直接去打开则会变成双重编码 → 「路径不存在」
	const readable = decodePathOnce(path);
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
	if (broken)
		return (
			<button
				type="button"
				className="md-path"
				title={tNow(
					"这张图没能加载，点这里在右侧打开这个文件",
					"Could not load this image — open the file on the right",
				)}
				onClick={() => openPathFromMessage(readable)}
			>
				{readable || alt}
			</button>
		);
	// 点图不跳新标签页：原地弹预览浮层（Esc / 点空白关闭）
	return (
		<button
			type="button"
			className="md-img-btn"
			title={tNow("点击放大预览", "Click to preview")}
			onClick={() => openImageViewer(src, alt)}
		>
			<img
				ref={ref}
				className="md-img"
				src={src}
				alt={alt}
				loading="lazy"
				onLoad={apply}
				onError={() => setBrokenSrc(src)}
			/>
		</button>
	);
}

/** hast 里我们只关心这几个字段：用来判断「这个段落是不是只有图片」 */
type HastChild = {
	type: string;
	tagName?: string;
	value?: string;
	children?: HastChild[];
	properties?: Record<string, unknown>;
};

/** 段落里可以忽略的节点：空白文本、换行 */
function isIgnorableNode(child: HastChild): boolean {
	if (child.type === "text") return (child.value ?? "").trim() === "";
	return child.type === "element" && child.tagName === "br";
}

/** 段落里的图：`<img>`，或指向本地图片的 `<a>`（`a` 分支会把这种链接直接渲染成图） */
function isImageNode(child: HastChild): boolean {
	if (child.type !== "element") return false;
	if (child.tagName === "img") return true;
	if (child.tagName !== "a") return false;
	const href = child.properties?.href;
	return typeof href === "string" && !/^https?:\/\//i.test(href) && isImagePath(href);
}

/**
 * 纯图片段落：子节点全是图（或可忽略的空白/换行），且至少有一张图。
 * 只有这种段落会换成 flex 容器；文字与图混排的段落保持普通 `<p>`（文字不能被挤进图格里）。
 */
function isImageOnlyParagraph(node: unknown): boolean {
	const kids = (node as HastChild | undefined)?.children;
	if (!Array.isArray(kids) || kids.length === 0) return false;
	let images = 0;
	for (const child of kids) {
		if (isImageNode(child)) {
			images += 1;
			continue;
		}
		if (!isIgnorableNode(child)) return false;
	}
	return images > 0;
}

const components: Components = {
	a: ({ href, children }) => {
		// 链接指向本地图片（`[shot.png](/abs/shot.png)`）：直接当图显示，不用用户再点一次
		if (typeof href === "string" && !/^https?:\/\//i.test(href) && isImagePath(href)) {
			const local = imageSrcOf(href);
			if (local) return <MessageImage src={local} path={href} alt={typeof children === "string" ? children : ""} />;
		}
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
		// 点图不跳新标签页，原地弹预览浮层（Esc / 点空白关闭）；图挂了则在这层回落成路径
		return <MessageImage src={resolved} path={typeof src === "string" ? src : ""} alt={alt ?? ""} />;
	},
	p: ({ node, children, ...rest }) => {
		// 相邻的「只有图片」段落已被 groupImageBlocks 并成一段：换成 flex 容器，小图就能并排
		// （宽度仍由每张图自己的上限决定，容器只负责换行；样式见 .md-img-grid）
		if (isImageOnlyParagraph(node)) return <div className="md-img-grid">{children}</div>;
		return <p {...rest}>{children}</p>;
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

/**
 * 流式渲染的节流与降级（markdown 是前端最贵的一件事）。
 *
 * 实测（25KB 正文 + 3 个代码块，`react-markdown` + remark-gfm + rehype-highlight）：
 * 一次「解析 + 高亮」≈ 26ms（其中高亮占 ~40%）。流式时每来一个 delta 正文就变一次、
 * 几十毫秒一次，等于把主线程一直按在解析里 —— **正文越长越贵，所以越到回复末尾越卡**，
 * 这就是「最后输出时页面卡一下」的来源。
 *
 * 所以流式中：① 文本按 150ms 节流上屏（约 7 次/秒，肉眼几乎无差别）；
 * ② 暂不上语法高亮（`rehype-highlight` 最贵，而流式中的代码块本来就还不完整）。
 * 收尾（`live` 变 false）立刻用最终文本完整渲染一次 —— 高亮就在这时补上。
 */
const STREAM_PARSE_INTERVAL_MS = 150;

function useStreamingText(text: string, live: boolean): string {
	const [shown, setShown] = useState(text);
	const latest = useRef(text);
	latest.current = text;
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!live) {
			// 收尾：丢掉还没执行的那一拍，立刻上最终文本
			if (timer.current !== null) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			setShown(text);
			return;
		}
		if (timer.current !== null) return; // 这一拍还没到：等它
		timer.current = setTimeout(() => {
			timer.current = null;
			setShown(latest.current);
		}, STREAM_PARSE_INTERVAL_MS);
	}, [live, text]);

	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);

	return live ? shown : text;
}

type MarkdownPlugins = NonNullable<React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>;
type RehypePlugins = NonNullable<React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>;

/** 插件表提到模块级：内联数组每次渲染都是新引用，没必要让 react-markdown 重算一遍处理器 */
const REMARK_PLUGINS: MarkdownPlugins = [remarkGfm];
const HIGHLIGHT_PLUGINS: RehypePlugins = [[rehypeHighlight, { detect: true, ignoreMissing: true }]];
/** 流式中先不上色：这一条就能省掉约 40% 的单帧解析成本 */
const NO_HIGHLIGHT: RehypePlugins = [];

export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
	// 流式期间只在节拍上换文本：每换一次就是一次完整重解析（见上面 useStreamingText）
	const shownText = useStreamingText(text, live);
	// 图片路径 → 图片，再把相邻的纯图片段落并成一组（多张时才能多列并排）
	const source = useMemo(() => groupImageBlocks(promoteImagePaths(shownText)), [shownText]);
	return (
		<div className="md">
			<ReactMarkdown
				remarkPlugins={REMARK_PLUGINS}
				rehypePlugins={live ? NO_HIGHLIGHT : HIGHLIGHT_PLUGINS}
				skipHtml
				components={components}
			>
				{source}
			</ReactMarkdown>
		</div>
	);
});
