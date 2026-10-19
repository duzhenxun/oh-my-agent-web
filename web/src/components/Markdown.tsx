import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { imageSrcOf, languageLabelOf } from "../markdown-media.ts";

/**
 * markdown 渲染（ADR-0008 §Markdown 安全渲染）。
 *  - `skipHtml`：模型输出里的原始 HTML 一律当文本，杜绝 `<script>`/`onerror` 之类；
 *  - 链接只放行 http(s)，且一律新窗口 + noopener；
 *  - 图片：远程图 / 已上传图 / **工作区里的图片文件**（走 /api/files/raw，受项目约束）；
 *  - 代码块：`rehype-highlight` 上色 + 显示语言标签（配色见 styles/highlight.css）。
 */
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
		if (!resolved) return <span className="md-img-blocked">[图片已拦截] {alt ?? ""}</span>;
		return (
			<a href={resolved} target="_blank" rel="noopener noreferrer" title="点击查看原图">
				<img className="md-img" src={resolved} alt={alt ?? ""} loading="lazy" />
			</a>
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
		const isBlock = language !== "" || (typeof children === "string" && children.includes("\n"));
		if (!isBlock)
			return (
				<code className={className} {...rest}>
					{children}
				</code>
			);
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

export function Markdown({ text }: { text: string }) {
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
}
