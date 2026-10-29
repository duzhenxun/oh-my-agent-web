import { useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "../use-language.ts";
import { anchorOfRange, captureAnchor, flatTextOf, type Anchor } from "../annotation-anchor.ts";

/**
 * 在对话里**选中一段文字**后浮出来的小工具栏（一次一条，跟着选区走）。
 *
 * 三颗按钮（后两颗只给**智能体的回复**，自己说的话标它没意义）：
 *   -「添加到会话」：直接收进这条会话 —— 正文里留一个编号，输入框**里面**那颗
 *     「N 条注释」立刻多一条（评论事后在那边补），回车就随消息一起发出去；
 *   -「标注」：先弹一个小输入框写一句评论，确认后再留编号收进去（就是原来那颗钮）；
 *   -「在临时会话中提问」：把同一段塞进右侧的临时会话（那条「临时聊天」），在那边接着问。
 *
 * 「添加到会话」与「标注」只差「那句评论什么时候写」：前者先收后补，后者先写再收。
 * 两条都不动草稿里的字 —— 标的时候用户往往正在打自己的问题，往草稿里塞东西就是在抢输入。
 *
 * 几个必须这么写的细节：
 *   - 工具栏按钮 `onMouseDown` 一律 `preventDefault()`：不然按下按钮前浏览器先把选区清掉，
 *     `selectionchange` 一走工具栏就自己消失，click 永远收不到（“点了没反应”）；
 *   - 「标注」那一步例外：输入框**要**拿焦点（于是选区会被收掉），所以用一个 ref 把
 *     `measure` / `selectionchange` 里的收起逻辑隔开（见下面 `commentingRef`）；
 *   - 只在「整段选区落在**同一条**消息里」时才出现：跨消息的选区属于“手滑”，
 *     给它一个动作反而危险；
 *   - 滚动、窗口改尺寸、选区塌掉 → 立刻收起（`position: fixed` 的浮层不跟着内容走）。
 */

type Picked = {
	text: string;
	/** 选区中心的横坐标 / 上下边（视口坐标） */
	centerX: number;
	top: number;
	bottom: number;
	/** 选区落在用户自己发的消息里 */
	inUser: boolean;
	/** 选区所在那条消息的 id + 量好的锚点（画编号用；量不到就是 null） */
	messageId: string;
	anchor: Anchor | null;
};

/** 「添加到会话」交出去的东西：原文 + 标在哪条消息哪一处（锚点量不到时是 null）+ 那句评论 */
export type SelectionAddInput = { text: string; messageId: string; anchor: Anchor | null; comment: string };

/** 选区所在的那条消息（`article.msg`）；跨消息就返回 null */
function messageOf(node: Node | null, host: HTMLElement): HTMLElement | null {
	const element = node === null ? null : node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	const message = element?.closest<HTMLElement>("article.msg") ?? null;
	return message !== null && host.contains(message) ? message : null;
}

/**
 * 选区 → 锚点。
 *
 * 正常情况量 `.msg-body` 的偏移；万一这一刻 DOM 刚好被重渲染换掉（流式追加时可能发生），
 * 退回「按原样文字找第一处」—— 上下文没了，但至少编号还挂在正确的那句话上。
 */
function anchorFor(message: HTMLElement, range: Range | null, text: string): Anchor | null {
	const body = message.querySelector<HTMLElement>(".msg-body");
	if (body === null) return null;
	const measured = range === null ? null : anchorOfRange(body, range);
	if (measured !== null) return measured;
	const at = flatTextOf(body).indexOf(text);
	return at < 0 ? null : captureAnchor(flatTextOf(body), at, at + text.length);
}

export function SelectionToolbar({
	container,
	onAddToSession,
	onAskInSideChat,
}: {
	/** 消息区（`.messages`）：只认这棵子树里的选区 */
	container: RefObject<HTMLElement | null>;
	/** 添加到会话：不传就不画这一颗（临时聊天 / 没有存储时不给） */
	onAddToSession?: (input: SelectionAddInput) => void;
	onAskInSideChat: (text: string) => void;
}) {
	const t = useT();
	const [picked, setPicked] = useState<Picked | null>(null);
	/**
	 * 「添加到会话」点下去之后的那一步：工具栏**变身**成一个小输入框（写一句评论，可留空）。
	 *
	 * 为什么留着这一步（用户明确要的）：把这段话收进会话是「一次表态」，而「为什么收它」
	 * 往往就在此刻脑子里 —— 让人先写完再落定，比事后去「N 条注释」里补一句顺得多。
	 * 留空直接回车也照旧算一条（只有编号、没有评论，见 annotations.ts）。
	 */
	const [commenting, setCommenting] = useState(false);
	const [draft, setDraft] = useState("");
	const toolbarRef = useRef<HTMLDivElement | null>(null);
	/**
	 * 评论小输入框要拿焦点，一拿焦点文档选区就塌了 —— `selectionchange` 会跟着来，
	 * 不拦的话工具栏会当场自己消失（“点了刚想写，框没了”）。用一个 ref 让那几处收起逻辑
	 * 在「正在写评论」时让路；点外面 / 滚动仍然收。
	 */
	const commentingRef = useRef(false);
	useEffect(() => {
		commentingRef.current = commenting;
	}, [commenting]);
	// 选区换了 / 收起来了：评论那一步跟着作废，别把上一段的评论写到这一段上
	useEffect(() => {
		if (!picked) {
			setCommenting(false);
			setDraft("");
		}
	}, [picked]);
	// 写着写着点了别处：整条收起来（输入框不挡住正文）
	useEffect(() => {
		if (!commenting) return;
		const onDown = (event: MouseEvent) => {
			if (toolbarRef.current?.contains(event.target as Node)) return;
			setPicked(null);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [commenting]);

	useEffect(() => {
		const host = container.current;
		if (!host) return;

		const measure = () => {
			/**
			 * 正在写评论就别重算了：输入框一拿焦点，文档选区就会被浏览器收掉 ——
			 * 不拦的话这一拍 `mouseup` 后的重算会判「选区没了」，把刚弹出来的输入框当场收走。
			 * 这一步要的东西（原文 + 锚点）点按钮前就已经量好了，不靠选区也能落定。
			 */
			if (commentingRef.current) return;
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
				setPicked(null);
				return;
			}
			const text = selection.toString().trim();
			if (text === "") {
				setPicked(null);
				return;
			}
			const range = selection.getRangeAt(0);
			const message = messageOf(range.commonAncestorContainer, host);
			if (!message) {
				setPicked(null);
				return;
			}
			const rect = range.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) {
				setPicked(null);
				return;
			}
			// 选区已经在视野外（程序化选中 / 滚动后残留的选区）：不要把它那套坐标画到屏幕外去
			if (rect.bottom < 0 || rect.top > window.innerHeight) {
				setPicked(null);
				return;
			}
			// 消息 id 就是 `article` 的 id 去掉 `msg-` 前缀（见 MessageList 的 `id={`msg-${message.id}`}`）
			const messageId = message.id.startsWith("msg-") ? message.id.slice(4) : "";
			setPicked({
				text,
				centerX: rect.left + rect.width / 2,
				top: rect.top,
				bottom: rect.bottom,
				inUser: message.classList.contains("msg-user"),
				messageId,
				// Range 要在这里就量成锚点：点了按钮选区就没了
				anchor: anchorFor(message, range.cloneRange(), text),
			});
		};

		// 选完一段再算：鼠标松开 / 键盘松开（Shift+方向键）/ 触屏抬手
		const onRelease = () => window.requestAnimationFrame(measure);
		// 选区没了（点了别处、按了 Esc）：立刻收起。写评论那一步例外：输入框拿焦点时选区本来就会塌
		const onSelectionChange = () => {
			if (commentingRef.current) return;
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed) setPicked(null);
		};
		const hide = () => setPicked(null);

		document.addEventListener("mouseup", onRelease);
		document.addEventListener("touchend", onRelease);
		document.addEventListener("keyup", onRelease);
		document.addEventListener("selectionchange", onSelectionChange);
		// 捕获阶段：消息区自己的滚动不冒泡，只有 capture 才收得到
		window.addEventListener("scroll", hide, true);
		window.addEventListener("resize", hide);
		return () => {
			document.removeEventListener("mouseup", onRelease);
			document.removeEventListener("touchend", onRelease);
			document.removeEventListener("keyup", onRelease);
			document.removeEventListener("selectionchange", onSelectionChange);
			window.removeEventListener("scroll", hide, true);
			window.removeEventListener("resize", hide);
		};
	}, [container]);

	if (picked === null) return null;

	/** 选区上方放不下（贴着视口顶 / 消息在顶部）就翻到下面 */
	const below = picked.top < 64;
	const style = {
		left: Math.min(Math.max(picked.centerX, 140), window.innerWidth - 140),
		top: below ? picked.bottom + 8 : picked.top - 8,
		transform: below ? "translate(-50%, 0)" : "translate(-50%, -100%)",
	} as const;

	const close = () => {
		setPicked(null);
		setCommenting(false);
		setDraft("");
		window.getSelection()?.removeAllRanges();
	};
	const keepSelection = (event: React.MouseEvent) => event.preventDefault();

	/** 确认：带评论（可为空）交出去 —— 收进会话的那条注记就是它 */
	const confirm = () => {
		onAddToSession?.({
			text: picked.text,
			messageId: picked.messageId,
			anchor: picked.anchor,
			comment: draft.trim(),
		});
		close();
	};

	/*
	 * 写评论那一步：工具栏整个变形成一颗输入胶囊（样式早就在 `annotations.css` 里留着了：
	 * `.sel-toolbar-comment` / `.sel-toolbar-input` / `.sel-toolbar-ok`）。
	 * 回车（或那颗 ✓）= 带评论收进会话，Esc = 取消。
	 */
	if (commenting) {
		return (
			<div
				ref={toolbarRef}
				className="sel-toolbar sel-toolbar-comment"
				style={style}
				role="dialog"
				aria-label={t("标注这一段", "Annotate this passage")}
			>
				<input
					className="sel-toolbar-input"
					autoFocus
					value={draft}
					placeholder={t("写一句评论（可留空）", "One line (optional)")}
					title={t("写一句评论，回车收进会话", "One line of comment; Enter adds it to this session")}
					aria-label={t("这一段的评论", "Comment for this passage")}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							confirm();
						} else if (event.key === "Escape") {
							// Esc = 取消这一条（整个收起）：不重置到两颗按钮 ——
							// 输入框拿焦点时选区已经塔了，退回去的那两颗按钮也就无东西可指了
							event.preventDefault();
							close();
						}
						event.stopPropagation();
					}}
				/>
				<button
					type="button"
					className="sel-toolbar-ok"
					title={t("收进会话", "Add to this session")}
					aria-label={t("收进会话", "Add to this session")}
					onMouseDown={keepSelection}
					onClick={confirm}
				>
					✓
				</button>
			</div>
		);
	}

	return (
		<div
			ref={toolbarRef}
			className="sel-toolbar"
			style={style}
			role="toolbar"
			aria-label={t("选中的文字", "Selected text")}
		>
			{/* 自己说的话再“添加到会话”没有意义（这些只在智能体回复上出现） */}
			{onAddToSession && !picked.inUser ? (
				<button
					type="button"
					className="sel-toolbar-btn"
					onMouseDown={keepSelection}
					onClick={() => {
						// 直接收：先留编号（评论后头在「N 条注释」里补，见 AnnotationSummary）
						onAddToSession({ text: picked.text, messageId: picked.messageId, anchor: picked.anchor, comment: "" });
						close();
					}}
					title={t(
						"把这段收进这条会话：正文里留个编号，评论可以在输入框里那颗注释上补",
						"Put this into this session: a number in the text; the note can be added inside the composer",
					)}
				>
					{t("添加到会话", "Add to session")}
				</button>
			) : null}
			{/*
			 * 「标注」：就是以前那颗 —— 点一下弹一个小输入框，写一句评论再收进会话。
			 * 与「添加到会话」的区别只在「什么时候写那句评论」：这边先写（脑子最清楚的时候），
			 * 那边先收、事后在注释列表里补。两个都不改草稿里的字。
			 */}
			{onAddToSession && !picked.inUser ? (
				<button
					type="button"
					className="sel-toolbar-btn"
					onMouseDown={keepSelection}
					onClick={() => {
						setDraft("");
						setCommenting(true);
					}}
					title={t(
						"标注这一段：写一句评论（可留空），正文里留个编号",
						"Annotate this passage: one line of comment (optional), plus a number in the text",
					)}
				>
					{t("标注", "Annotate")}
				</button>
			) : null}
			<button
				type="button"
				className="sel-toolbar-btn"
				onMouseDown={keepSelection}
				onClick={() => {
					onAskInSideChat(picked.text);
					close();
				}}
			>
				{t("在临时会话中提问", "Ask in a temp session")}
			</button>
		</div>
	);
}
