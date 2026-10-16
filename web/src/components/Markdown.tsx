import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

/**
 * markdown 渲染（ADR-0008 §Markdown 安全渲染）。
 *  - `skipHtml`：模型输出里的原始 HTML 一律当文本，杜绝 `<script>`/`onerror` 之类；
 *  - 链接只放行 http(s)，且一律新窗口 + noopener。
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
};

export function Markdown({ text }: { text: string }) {
	return (
		<div className="md">
			<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} skipHtml components={components}>
				{text}
			</ReactMarkdown>
		</div>
	);
}
