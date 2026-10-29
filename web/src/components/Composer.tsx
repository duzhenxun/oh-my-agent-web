import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ClipboardEvent,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import { imagesMarkdown, pickUploadableFiles, uploadFile } from "../attachments.ts";
import { annotationsAsMessage, type Annotation } from "../annotations.ts";
import { PLAIN_TEXT_INPUT } from "../plain-text-input.ts";
import { ModelChips } from "./ModelChips.tsx";
import { ProjectBranchChips } from "./ProjectBranchChips.tsx";
import { ThinkButton } from "./ThinkButton.tsx";
import { TemplateEditor, TemplateGallery } from "./TemplateModals.tsx";
import { setDraft as setStoreDraft, useAppState } from "../store.ts";
import { COMPOSER_ITEM_KEY, COMPOSER_TOGGLES } from "../ui-prefs.ts";
import { usePrefFlags } from "../use-pref-flags.ts";
import { useSeedQuickFromServer } from "../use-quick-seed.ts";
import type { AttachmentRef, PromptTemplate, SendMode } from "../types.ts";
import { interrupt, sendMessage, createSessionAndSend } from "../ws.ts";
import type { ChatSurface } from "../chat-surface.ts";
import { useT } from "../use-language.ts";
import { showToast } from "../toast.ts";
import { openImageViewer } from "../image-viewer.ts";
import { SlashPalette } from "./SlashPalette.tsx";
import { MentionPalette } from "./MentionPalette.tsx";
import {
	applyMention,
	buildMentionRows,
	insertReference,
	mentionPathFor,
	parseMentionInput,
	type MentionRow,
} from "../at-mentions.ts";
import { useFileMention } from "../use-file-mention.ts";
import { NewSessionScope } from "./NewSessionScope.tsx";
import {
	commandDraft,
	filterCommands,
	isAppCommand,
	filterSkills,
	parseSlashInput,
	runSlashCommand,
	type SkillChoice,
	type SlashCommand,
} from "../slash-commands.ts";

/** 输入框自适应高度的上限：超过就内部滚动，不把对话区挤没 */
const INPUT_MAX_HEIGHT = 240;

/** 快捷短语连点保护窗口：比一次往返慢一点，够挡住手机的「双击」 */
const QUICK_SEND_GUARD_MS = 700;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 输入区：快捷短语行（ADR-0020 §P1）+ 待发附件（ADR-0020 §P3）+ 多行输入框。
 *
 * 粘贴截图：剪贴板里的图片直接上传（不塞 WS），显示成待发 chip；
 * 发送时把 `AttachmentRef` 交给服务端（图片做视觉注入），并把 markdown 图片引用写进正文，
 * 这样**刷新之后图片仍然显示**（引用随会话文件落盘）。
 */
export function Composer({
	running,
	conversationId,
	surface,
	newSession = null,
	tempChat = false,
	annotations = [],
	onAnnotationsSent,
	annotationSummary = null,
}: {
	running: boolean;
	conversationId: string | null;
	/**
	 * 换个「聊天面」来跑这一份 UI（`web/src/chat-surface.ts`）。
	 * 不传 = 主对话：草稿 / 快照 / 发送都走全局 store 与主通道（老路径，行为一字不变）。
	 * 临时聊天传它自己那条通道的实现，于是两边用的是**同一份输入框**。
	 */
	surface?: ChatSurface;
	/**
	 * 这条是右侧分栏里的「临时聊天」（见 `components/SideChat.tsx`）。
	 *
	 * 那儿只干一件事：选中一段话 → 过去问一句。快捷短语和模板库都是主对话的加速器，
	 * 摆在这么窄的一条里只会把输入框挤没 —— 所以这两样不画（模型 / 强度 / 想想 / 附件照旧）。
	 */
	tempChat?: boolean;
	/**
	 * 「新会话界面」（`store.ts` 的 `newSession`）：非 null = 这条会话**还没建**，
	 * 工具行里（模型左边）多出「项目 · 分支」两颗，第一条消息发出去的时候才真建会话
	 * （`ws.ts` 的 `createSessionAndSend`）。建好之后 App 就不再传它，那两颗自然消失。
	 */
	newSession?: {
		workspace: string | null;
		/** 「临时会话（不保存）」：建会话时带 `ephemeral`，只活在内存里 */
		ephemeral: boolean;
		onWorkspaceChange: (cwd: string | null) => void;
		onEphemeralChange: (ephemeral: boolean) => void;
	} | null;
	/**
	 * 这条对话里的标注（`annotations.ts`）。它们**算待发内容**：有标注时发送按钮就该亮着，
	 * 回车也能把这几处连同评论一起发出去 —— 否则标了三四条还得一条条点「放进输入框」，
	 * 等于没做这个功能。
	 */
	annotations?: readonly Annotation[];
	/** 标注已经随这条消息发出去了：调用方据此清掉列表（不清就会一直重复发同一批） */
	onAnnotationsSent?: () => void;
	/**
	 * 输入框**里面**那一行「N 条注释」（见 `components/AnnotationSummary.tsx`）。
	 *
	 * 由 App 渲染好传进来：标注的增删改都在 App 那层（它管会话切换与 localStorage），
	 * 这里只负责给它一个位置 —— `.composer` 的边框之内、输入框上方。
	 */
	annotationSummary?: ReactNode;
}) {
	const t = useT();
	const app = useAppState();
	// 这几个原语是「这一面」的：主对话直接落到全局，临时聊天落到它自己的通道
	const draft = surface ? surface.draft : app.draft;
	const setDraft = surface ? surface.setDraft : setStoreDraft;
	const snapshot = surface ? surface.snapshot : app.snapshot;
	const creating = surface ? false : app.creating;
	const [pending, setPending] = useState<AttachmentRef[]>([]);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	/**
	 * 附件是**属于会话**的（图片引用会随会话文件落盘），所以切会话必须清空待发附件，
	 * 上传中的也要作废：否则在 A 里粘的截图会跟着发到 B 的对话里。
	 */
	const conversationRef = useRef(conversationId);
	conversationRef.current = conversationId;
	useEffect(() => {
		setPending([]);
		setUploadError(null);
		setUploading(false);
	}, [conversationId]);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	/** 输入框外面那层（用来写 --composer-actions-w） */
	const composerRef = useRef<HTMLDivElement>(null);
	/** 右下角那组动作按钮（发送 / 排队 / 插队 / 停止） */
	const actionsRef = useRef<HTMLDivElement>(null);
	/**
	 * 输入框高度跟着**内容**走，而不是只跟着打字走；CSS 的 min-height 托底。
	 *
	 * 模板库 / 模板编辑器的「用这个」/ 快捷短语 / 切会话恢复草稿都是外部直接改 `draft`，
	 * 这些路径没有 input 事件，只写在 onChange 里就会让框停在一行：长文案被裁掉，还得再敲一个字才展开。
	 *
	 * 为什么抽成一个函数：撑高它的不只「打字」两件事 ——
	 *   1. `draft` 变了（打字 / 模板 / 快捷短语 / 切会话恢复草稿）；
	 *   2. 右下角按钮组的数量变了（手机上「排队 + 插队 + 停止」竖排要 114px，
	 *      只剩一颗「停止」只要 34px，而 CSS 的 min-height 就按这个实测值算）。
	 * 以前只在 `draft` 变化时算，于是「三颗按钮时写下 128px」的内联高度会一直撑着：
	 * 草稿清空 / 回合结束、按钮都退回一颗了，框里下面还空两行（用户反馈的「输入框太大」）。
	 */
	const fitInputHeight = useCallback(() => {
		const element = inputRef.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, INPUT_MAX_HEIGHT)}px`;
	}, []);

	useLayoutEffect(() => {
		fitInputHeight();
	}, [draft, fitInputHeight]);
	/**
	 * 把右下角按钮组的实际宽度写进 --composer-actions-w。
	 *
	 * 这组按钮是绝对定位压在输入框里的，文字不会自己绕开它；而按钮会随状态在
	 * 1 个（发送 / 停止，约 72px）与 3 个（排队 + 插队 + 停止，约 230px）之间切，
	 * 宽度差一倍多 —— 所以只能实测，不能写死一个内边距。
	 *
	 * 高度也要测：手机上这组按钮**竖着排**（横着占屏幕宽度太狠），一列三颗比单行高得多，
	 * 输入框得跟着长高才压得住它们（否则按钮会溢出到框外）—— 见 `--composer-actions-h`。
	 */
	useLayoutEffect(() => {
		const host = composerRef.current;
		const actions = actionsRef.current;
		if (!host || !actions) return;
		const apply = () => {
			const box = actions.getBoundingClientRect();
			host.style.setProperty("--composer-actions-w", `${Math.ceil(box.width)}px`);
			host.style.setProperty("--composer-actions-h", `${Math.ceil(box.height)}px`);
			/* 按钮组一变，min-height 跟着变 —— 输入框得立刻重算一次，
			   否则上一个状态留下的内联高度会把空行留在框里（见 fitInputHeight 的注释）。 */
			fitInputHeight();
		};
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(actions);
		return () => observer.disconnect();
	}, [fitInputHeight]);
	/**
	 * 快捷短语的「刚发过」闸门（毫秒时间戳）。
	 *
	 * 手机上加倍容易连点两下：第一下其实已经发出去了，只是**界面要等快照回来才知道**，
	 * 看起来像没反应 → 于是再点一下 → 服务端收到两条「发消息」（当时都还没有会话），
	 * 各建一个会话。这里把 700ms 内的重复点击直接吞掉，配合服务端按客户端合并新建请求。
	 */
	const lastQuickSend = useRef(0);

	// 点「新会话」→ 建好后把光标直接放进输入框（下一步肯定是打字，少点一次）。
	// 只在新会话**刚建好**这一刻抢焦点：切会话时不抢（否则手机上会莫名弹出键盘）。
	const wasCreating = useRef(false);
	useEffect(() => {
		const justCreated = wasCreating.current && !creating;
		wasCreating.current = creating;
		if (!justCreated || !inputRef.current) return;
		// 别把别人正在打的字顶掉（例如建会话失败、用户已经在别处输入）
		const active = document.activeElement;
		if ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active !== inputRef.current) {
			return;
		}
		inputRef.current.focus();
	}, [creating]);

	// 主对话左侧那两颗「项目 · 分支」：**桌面和手机都画**（用户 2026-10-29 定：手机上也要看得到）。
	// 会话属于哪个项目是已定的事，写在输入框上方比缩在底部状态栏更好认；
	// 手机那一排是横向可滑的（`responsive.css` 里 .composer-tools 就是 nowrap + overflow-x），
	// 放不下就滑一下，不会把输入框挤没。临时聊天（surface）不画：那是另一条对话，
	// 而且那块本来就窄。
	const projectChips = surface
		? null
		: (snapshot?.conversations.find((item) => item.id === snapshot.active.conversationId)?.workspace ??
			snapshot?.files?.root ??
			null);
	/**
	 * 「模型 · 强度」这两颗要不要画在这一排：
	 *  - **主对话（桌面和手机都是）：不画** —— 它们在**底部状态栏**，引擎那颗（`PI ▾`）的**右边**
	 *    （用户 2026-10-29 定，跟审批 / 引擎算一类的：都是「这一步怎么跑」；手机也要，同一天补的）；
	 *  - **临时聊天**（surface）：画 —— 那是**另一条对话**、另一个模型通道，状态栏那颗说的是主对话，
	 *    在这儿换成它自己的才对，不能去共用底下那颗。
	 */
	const chipsHere = surface !== undefined;
	/** 这一排左边已经有没有东西（决定分隔标要不要画，免得最左边飘一根竖线） */
	const leading = Boolean(chipsHere || newSession || projectChips);
	// 「模板 / 想想 / 快捷指令」三块要不要显示：默认都显示，开关在设置 → 界面 → 对话窗口。
	// 纯本机偏好（localStorage）：手机和桌面各一份，一边关掉不会带走另一边。
	const [showBlocks] = usePrefFlags(COMPOSER_TOGGLES, COMPOSER_ITEM_KEY);
	/**
	 * 斜杠命令面板：输入框里打 `/` 开头就弹，**选中只是把命令补全**（不直接执行），
	 * 执行发生在发送时（见 submit）：带参数的命令得让人先把参数敲完。
	 */
	const slashInput = parseSlashInput(draft);
	const slashCommands = slashInput?.mode === "commands" ? filterCommands(slashInput.term) : [];
	/**
	 * 技能列表：`/skill ` 时列出来让人挑（数据来自 `GET /api/skills`，和技能面板同一份）。
	 * 懒加载 + 只拉一次：不打斜杠命令的人不该为此多打一次请求。
	 */
	const [skills, setSkills] = useState<SkillChoice[] | null>(null);
	/** 拉一次技能表（面板挑技能、以及发送前校验 `/skill:名字` 都用它） */
	const loadSkills = async (): Promise<SkillChoice[]> => {
		try {
			const response = await fetch("/api/skills");
			const body = (await response.json()) as { skills?: SkillChoice[] };
			const list = body.skills ?? [];
			setSkills(list);
			return list;
		} catch {
			setSkills([]);
			return [];
		}
	};
	useEffect(() => {
		if (slashInput?.mode !== "skills" || skills !== null) return;
		void loadSkills();
		// loadSkills 是每次渲染新建的闭包，但它只读 state 的 setter，不需要进依赖
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [slashInput?.mode, skills]);
	const slashSkills = slashInput?.mode === "skills" ? filterSkills(skills ?? [], slashInput.term) : null;
	const [slashActive, setSlashActive] = useState(0);
	/** 面板要列几行：命令模式下是命令，技能模式下是技能 */
	const slashCount = slashSkills === null ? slashCommands.length : slashSkills.length;
	const slashOpen = slashInput !== null && (slashCount > 0 || slashSkills !== null);
	useEffect(() => setSlashActive(0), [slashInput?.mode, slashInput?.term]);

	/** 补全一条命令：把 `/name ` 填进输入框，光标停在参数位置 */
	const pickCommand = (command: SlashCommand) => {
		setDraft(commandDraft(command));
		requestAnimationFrame(() => inputRef.current?.focus());
	};

	/** 补全一个技能：`/skill:<名字> ` —— pi 认这个写法（会展开成技能正文） */
	const pickSkill = (name: string) => {
		setDraft(`/skill:${name} `);
		requestAnimationFrame(() => inputRef.current?.focus());
	};

	/* ---------------- 「@ 提及」：`@` 后面搜文件 / 只打 `@` 时能从电脑里挑 ---------------- */
	/**
	 * 搜索用哪个工作区根：新会话界面用「这条会话将要落在的项目」，其余用当前项目根。
	 * `@` 引用的相对路径就是相对它写的（和文件树、文件预览一致）。
	 */
	const mentionRoot = newSession ? newSession.workspace : (snapshot?.files?.root ?? null);
	/**
	 * 光标位置：`@` 提及只认「光标处那一段」，所以打字、鼠标点、方向键都得把光标记下来 ——
	 * 只看草稿末尾的话，在句子中间插一个 `@` 就永远不会弹面板。
	 */
	const [caret, setCaret] = useState(0);
	const caretRef = useRef(0);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	/**
	 * 光标会由**输入框自己**移动（点、方向键、Home/End），那些动作不一定带 input 事件：
	 * 只在 onChange 里记光标的话，`@comp` 打完再把光标点到别处，面板会赖着不走、
	 * 而且插入时还会替换掉原来那个词（用户看到的是「把没动过的字改了」）。
	 * `selectionchange` 是文档级的，textarea 也发 —— 这是唯一可靠的“光标真的动了”信号。
	 */
	useEffect(() => {
		const syncCaret = () => {
			const element = inputRef.current;
			if (!element || document.activeElement !== element) return;
			const position = element.selectionStart ?? 0;
			caretRef.current = position;
			setCaret(position);
		};
		document.addEventListener("selectionchange", syncCaret);
		return () => document.removeEventListener("selectionchange", syncCaret);
	}, []);
	/** Esc 关掉的是**哪一个** `@`（按它的起点记）：继续打同一个词不再弹，换一处打照常弹 */
	const [mentionOff, setMentionOff] = useState<number | null>(null);
	const [mentionActive, setMentionActive] = useState(0);
	/** 原生选择框开着的时候禁一下：两个框叠在一起用户会不知道哪个算数 */
	const [pickingPath, setPickingPath] = useState(false);

	const mentionInput = parseMentionInput(draft, caret);
	const mention = mentionInput && mentionInput.start !== mentionOff ? mentionInput : null;
	const mentionSearch = useFileMention(mentionRoot, mention ? mention.term : null);
	const mentionRows =
		mention === null
			? []
			: buildMentionRows({ term: mention.term, results: mentionSearch.results, recent: mentionSearch.recent });
	/** 高亮那条（结果变少时夹一下，别让 ↑↓ 停在已经不存在的那一行） */
	const mentionIndex = Math.min(mentionActive, Math.max(0, mentionRows.length - 1));
	useEffect(() => setMentionActive(0), [mention?.term, mention?.start]);

	/**
	 * 把一条路径填进草稿。
	 *
	 * 只在**光标处**替换掉那个 `@关键字`：
	 *  - 正常路径：`@js` + `web-push/server.js` → `@web-push/server.js |`（光标跟在空一格之后）；
	 *  - 光标处已经没这个 token 了（例如按 Esc 关过面板、或用「浏览电脑」时对话框跑到了前台），
	 *    就纯插入，不吞掉用户已经写好的别的字。
	 */
	const applyReference = (path: string, isDir: boolean) => {
		const reference = mentionPathFor(path, mentionRoot);
		if (reference === "") return;
		/* 光标以**此刻输入框里的真实位置**为准（不等 state）：
		 * 「浏览电脑」是个异步往返，对话框回来时用户可能已经又点/敲了别处。 */
		const element = inputRef.current;
		const text = element?.value ?? draftRef.current;
		const live = element?.selectionStart ?? caretRef.current;
		const at = Math.min(Math.max(live, 0), text.length);
		const current = parseMentionInput(text, at);
		const next = current ? applyMention(text, current, reference) : insertReference(text, at, reference);
		setDraft(next.text);
		caretRef.current = next.caret;
		setCaret(next.caret);
		setMentionOff(null);
		mentionSearch.remember({ path: reference, isDir });
		// 焦点与光标要等这次渲染把新草稿写进 textarea 之后再摆
		requestAnimationFrame(() => {
			const element = inputRef.current;
			if (!element) return;
			element.focus();
			element.setSelectionRange(next.caret, next.caret);
		});
	};

	/**
	 * 在**服务端那台电脑**上弹原生文件/目录选择框（浏览器拿不到本机绝对路径）。
	 * 开不出来（无图形会话 / 平台不支持 / 服务端是旧版本）就如实说一句 —— 不假装成功。
	 */
	const browsePath = async (kind: "file" | "dir") => {
		if (pickingPath) return;
		setPickingPath(true);
		try {
			const response = await fetch("/api/fs/pick-path", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind }),
			});
			const raw = await response.text();
			type PickBody = {
				path?: string;
				canceled?: boolean;
				unsupported?: boolean;
				message?: string;
				error?: { message?: string };
			};
			let body: PickBody | null = null;
			try {
				body = JSON.parse(raw) as PickBody;
			} catch {
				// 旧服务端没有这个接口会落到 SPA 的静态兜底，回一页 HTML —— 别把 `Unexpected token '<'` 甩给用户
				showToast({
					text: raw.trimStart().startsWith("<")
						? `服务端还没有这个接口（HTTP ${response.status}）—— 服务可能在跑旧版本，重启一下就好`
						: `服务端返回的不是 JSON（HTTP ${response.status}）`,
				});
				return;
			}
			if (!body) return;
			if (!response.ok) {
				showToast({ text: body.error?.message ?? body.message ?? `HTTP ${response.status}` });
				return;
			}
			if (body.canceled) return; // 取消：什么都不做（别把用户已经打的字改掉）
			if (body.unsupported || !body.path) {
				showToast({ text: body.message ?? "这台机器上开不出文件选择框：直接 @ 搜文件名也可以" });
				return;
			}
			applyReference(body.path, kind === "dir");
		} catch (cause) {
			showToast({ text: cause instanceof Error ? cause.message : String(cause) });
		} finally {
			setPickingPath(false);
		}
	};

	/** 选中面板里的一行：挑选入口走原生对话框，文件行直接填进草稿 */
	const pickMentionRow = (row: MentionRow) => {
		if (row.kind === "browse") void browsePath(row.target);
		else applyReference(row.path, row.isDir);
	};

	// 老版本把这一项存在服务端（`quickPhrasesEnabled`，多设备一致）：本机没写过就抄一次旧值
	useSeedQuickFromServer(snapshot?.settings.quickPhrasesEnabled);
	// 关掉时连短语都不取，下面 `quickPhrases.length > 0` 那个判断就顺手把整行和分隔线收掉了
	const quickPhrases = showBlocks.quick && !tempChat ? (snapshot?.settings.quickPhrases ?? []) : [];
	const templates = snapshot?.settings.templates ?? [];
	// 模板库 / 模板编辑两个弹窗（P5）
	const [galleryOpen, setGalleryOpen] = useState(false);
	const [editing, setEditing] = useState<{ template: PromptTemplate | null } | null>(null);

	const addFiles = async (files: File[]) => {
		if (files.length === 0) return;
		const { accepted, rejected } = pickUploadableFiles(files, pending.length);
		if (rejected.length > 0) setUploadError(rejected.join("；"));
		if (accepted.length === 0) return;

		// 上传开始时的会话快照：附件是**属于会话**的（会随会话文件落盘），
		// 上传途用户切走了就不能再把结果塞进新会话的待发区（否则 A 的图会跟着发到 B）
		const startedIn = conversationRef.current;
		setUploading(true);
		const uploaded: AttachmentRef[] = [];
		for (const file of accepted) {
			const result = await uploadFile(file);
			if (conversationRef.current !== startedIn) return; // 切会话了：这次上传整个作废
			if (result.ok) uploaded.push(result.attachment);
			else setUploadError(result.error);
		}
		setUploading(false);
		if (uploaded.length > 0) {
			setPending((current) => [...current, ...uploaded].slice(0, 5));
			setUploadError(null);
		}
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		// 只看图片：纯文本粘贴交回给浏览器默认行为
		const files = [...event.clipboardData.items]
			.filter((item) => item.kind === "file")
			.map((item) => item.getAsFile())
			.filter((file): file is File => file !== null);
		if (files.length === 0) return;
		event.preventDefault();
		void addFiles(files);
	};

	/**
	 * `/skill:<名字>` 发出前先对一下技能表。
	 *
	 * 为什么要这一步：pi 的展开逻辑里，**名字对不上就把原文原样交给模型** —— 不报错、不提示。
	 * 于是打错一个字、或那个技能在「技能」面板里被停用，表现完全一样：
	 * 界面上是一条正常的用户消息，模型则收到字面的 `/skill:xxx`，回一句"我不明白"。
	 * 这里至少让用户在点发送的**当下**就知道「这个名字不认」。
	 */
	const checkSkillName = async (text: string): Promise<void> => {
		const name = /^\/skill:([^\s]+)/i.exec(text)?.[1] ?? "";
		if (name === "") return;
		const list = skills ?? (await loadSkills());
		const hit = list.find((item) => item.name.toLowerCase() === name.toLowerCase());
		if (!hit) {
			showToast({ text: `没有叫「${name}」的技能：会当普通文本发出去。去「技能」面板核对名字` });
			return;
		}
		if (!hit.enabled) showToast({ text: `技能「${name}」是停用状态：pi 不会加载它（去「技能」面板启用）` });
	};

	/**
	 * 发一句话（带附件与发送模式）。
	 *
	 * 三种落点，区别只在「发给谁」：
	 *  - 有 `surface`（临时聊天）→ 走它自己那条通道；
	 *  - 新会话界面（`newSession` 非 null）→ **先建会话，建好再发**（这条会话此刻还不存在）；
	 *  - 其余 → 老路径，直接发给当前会话。
	 */
	const deliver = (text: string, attachments?: AttachmentRef[], mode: SendMode = "now") => {
		if (surface) surface.send(text, attachments, mode);
		else if (newSession)
			createSessionAndSend(text, attachments, mode, newSession.workspace ?? undefined, {
				// 引擎不支持（不是 pi）就不带这一位：宁可建成普通会话，也不要报一个看不懂的错。
				// 菜单项本身在 `NewSessionScope` 里就按这一位隐藏了，这里是引擎切走之后的兜底。
				ephemeral: newSession.ephemeral && snapshot?.engineCapabilities.ephemeralChat === true,
			});
		else sendMessage(text, attachments, mode);
	};

	// 标注 = 待发内容：它们和草稿、附件并列，任一样有东西，发送就该是亮的
	const notes = annotationsAsMessage(annotations);
	// 提示语里数的是「这一回车会真的发出去的」那几条（已放进输入框的不算：它们已经躺在草稿里了）
	const pendingNotes = annotations.filter((item) => item.quoted !== true).length;
	const canSend = draft.trim() !== "" || pending.length > 0 || notes !== "";

	const submit = (mode: "now" | "queue" | "steer" = "now") => {
		const value = draft.trim();
		if (!value && pending.length === 0 && notes === "") return;
		// 技能名对不上是最常见的「发了但没生效」，先把话说清楚（不影响发送）
		if (/^\/skill:/i.test(value)) void checkSkillName(value);
		// 斜杠命令：**只有宿主自己做得动的那些**就地做完、不回显成一条聊天消息。
		// 其余（`/compact`、`/plan`、`/cwd`、`/skill:xxx`、根本不认识的）一律照常发给引擎 ——
		// 以前这里用「首词是不是 agent 类命令」反推，`/skill:smart-charts …` 两头都不匹配，
		// 结果既没执行也没发送：点发送按钮毫无反应（用户报的 bug）。
		if ((surface?.hostCommands ?? true) && isAppCommand(value)) {
			void runSlashCommand(value, snapshot).then((outcome) => {
				if (!outcome.handled) return;
				setDraft("");
				setPending([]);
			});
			return;
		}
		if (running && mode === "now") return;
		// 标注接在草稿后面（没草稿就单独发一批）：形状跟「放进输入框」一致，模型分得清哪句是引用
		const body = value === "" ? notes : notes === "" ? value : `${value}\n\n${notes}`;
		// 图片引用写进正文（刷新后仍显示）；附件本体走 references
		const text = body + imagesMarkdown(pending);
		deliver(text, pending.length > 0 ? pending : undefined, mode);
		setDraft(""); // 高度由上面那个 effect 跟着 draft 一起收回一行
		setPending([]);
		setUploadError(null);
		if (notes !== "") onAnnotationsSent?.();
	};

	return (
		<div className="composer-wrap">
			<div className="composer-topbar">
				{/* 输入框上方一行：模型 / 强度 · 模板 · 想想 + 快捷短语（审批在底部状态栏） */}
				<div className="composer-tools">
					{/*
					 * 「新会话界面」的项目 · 分支：排在**模型左边**（用户要求：别单占一整行）。
					 * 它跟这一行其它颗是同一个样式族（`.tool-chip`），所以看起来就是这一排普通按钮之一；
					 * 不是 git 仓库时分支那颗自己就不画（见 NewSessionScope），只剩项目一颗。
					 * 会话一建出来 App 就不再传 `newSession`，这几颗连同下面的竖线一起消失。
					 */}
					{/*
					 * 项目 · 分支：**已建好的会话**在这一排左边常驻两颗（用户 2026-10-29 定：手机也要）。
					 * 项目那颗只是显示「这条会话落在哪个目录」（已定，改不了，所以不可点）；
					 * 是 git 仓库时再多一颗分支，点开就是文件区那张分支菜单，选一项真的 checkout。
					 * 新会话时不画：那一刻 `NewSessionScope` 已经在同一位置画了「项目 ▾ · 分支 ▾」，
					 * 两套并排会让人分不清哪个算数。
					 */}
					{newSession ? (
						<>
							<NewSessionScope
								workspace={newSession.workspace}
								ephemeral={newSession.ephemeral}
								onChange={newSession.onWorkspaceChange}
								onEphemeralChange={newSession.onEphemeralChange}
							/>
							{/* 竖线只隔「项目·分支」和紧跟着的「模型·强度」：桌上上它们不在这排（在状态栏），
							    这条线就交给下面「模板 / 想想」前那根，不在这里重复画 */}
							{chipsHere ? <span className="tool-sep" aria-hidden="true" /> : null}
						</>
					) : projectChips ? (
						<>
							<ProjectBranchChips projectRoot={projectChips} />
							{chipsHere ? <span className="tool-sep" aria-hidden="true" /> : null}
						</>
					) : null}
					{/* 模型 / 强度：手机上（以及临时聊天）在这一排；桌面上它们在底部状态栏的引擎右边 */}
					{chipsHere ? <ModelChips surface={surface} /> : null}
					{/* 下面两块的显隐由设置控制；隐藏时分隔线跟着一起消失，免得留下一根悬空的竖线 */}
					{showBlocks.templates && !tempChat ? (
						<>
							{leading ? <span className="tool-sep" aria-hidden="true" /> : null}
							<button
								type="button"
								className="tool-chip composer-template-btn"
								onClick={() => setGalleryOpen(true)}
								title={t("提示词模板库", "Prompt template library")}
							>
								🧩 {t("模板", "Templates")}
							</button>
						</>
					) : null}
					{showBlocks.think ? (
						<>
							{leading || (showBlocks.templates && !tempChat) ? <span className="tool-sep" aria-hidden="true" /> : null}
							<ThinkButton conversationId={conversationId} running={running} />
						</>
					) : null}
					{/* 右侧扩展位：工具范围 / 压缩（P4 待做，先占位保持排布稳定） */}
					<span className="topbar-spacer" />
				</div>

				{quickPhrases.length > 0 ? (
					<>
						<span className="tool-sep" aria-hidden="true" />
						<div className="quick-row">
							{quickPhrases.map((phrase) => (
								<button
									type="button"
									key={phrase}
									className="quick-chip"
									disabled={running}
									title={`${phrase}（点击直接发送 · Shift+点击只填入）`}
									onClick={(event) => {
										if (event.shiftKey) {
											setDraft(phrase);
											inputRef.current?.focus();
											return;
										}
										if (running) return;
										const now = Date.now();
										if (now - lastQuickSend.current < QUICK_SEND_GUARD_MS) return; // 连点第二下：忽略
										lastQuickSend.current = now;
										// 新会话界面里点快捷短语 = 用这句话发起这条新会话（跟回车发送同一个落点）
										deliver(phrase);
									}}
								>
									{phrase}
								</button>
							))}
						</div>
					</>
				) : null}
			</div>

			{pending.length > 0 || uploading || uploadError ? (
				<div className="attach-row">
					{pending.map((attachment) => (
						<span className="attach-chip" key={attachment.id} title={`${attachment.mime} · ${attachment.name}`}>
							{attachment.kind === "image" ? (
								<img
									className="attach-thumb"
									src={`/api/uploads/${attachment.id}`}
									alt={attachment.name}
									title={t("点击放大预览", "Click to preview")}
									onClick={() => openImageViewer(`/api/uploads/${attachment.id}`, attachment.name)}
								/>
							) : (
								<span className="attach-kind">📄</span>
							)}
							<span className="attach-name">{attachment.name}</span>
							<span className="attach-size">{formatBytes(attachment.bytes)}</span>
							<button
								type="button"
								className="attach-remove"
								title={t("移除", "Remove")}
								onClick={() => setPending((current) => current.filter((item) => item.id !== attachment.id))}
							>
								×
							</button>
						</span>
					))}
					{uploading ? <span className="attach-hint">{t("上传中…")}</span> : null}
					{uploadError ? <span className="attach-error">{uploadError}</span> : null}
				</div>
			) : null}

			{slashOpen && mention === null ? (
				<SlashPalette
					commands={slashCommands}
					skills={slashSkills}
					active={slashActive}
					onPick={(command) => {
						// 技能条目（名字带 `skill:` 前缀）走「插入技能」；其它命令照旧补全成 `/name `
						if (command.name.startsWith("skill:")) pickSkill(command.name.slice("skill:".length));
						else pickCommand(command);
					}}
					onHover={setSlashActive}
				/>
			) : null}

			{/*
			 * 「@ 提及」面板：和斜杠面板同一个位置 —— 两个浮层不会同时出现
			 * （`/命令` 里一带空格斜杠面板自己就关了，`@` 才是那一段的主角）。
			 */}
			{mention !== null ? (
				<MentionPalette
					rows={mentionRows}
					active={mentionIndex}
					loading={mentionSearch.loading}
					error={mention.term.trim() === "" ? null : mentionSearch.error}
					onPick={(row) => applyReference(row.path, row.isDir)}
					onHover={setMentionActive}
					onBrowse={(target) => void browsePath(target)}
				/>
			) : null}

			<div className="composer" ref={composerRef}>
				{annotationSummary}
				<textarea
					ref={inputRef}
					className="composer-input"
					/* 手机点进来时，键盘上方那排「系统猜出来的」东西（密码钥匙 / 联想条）能少一点：
					   属性包见 plain-text-input.ts（含「网页到底能压掉什么、压不掉什么」的说明）。
					   回车键印字跟着状态走：空闲时就是「发送」（跟 Enter 直接发一致），
					   跑的时候是「排队」——手感与真正的动作对齐，不在这儿许诺做不到的事。 */
					{...PLAIN_TEXT_INPUT}
					enterKeyHint={running ? "enter" : "send"}
					value={draft}
					placeholder={
						running
							? t("正在跑…回车排队", "Running… Enter to queue")
							: draft.trim() === "" && notes !== ""
								? t(`回车发送 ${pendingNotes} 条注释`, `Enter to send ${pendingNotes} note(s)`)
								: t("说点什么，回车发送", "Say something — Enter to send")
					}
					onChange={(event) => {
						const value = event.target.value;
						const position = event.target.selectionStart ?? value.length;
						setDraft(value);
						caretRef.current = position;
						setCaret(position);
						// 那个 `@` 已经被删掉/改掉了：之前按 Esc 的「关掉」不再算数
						if (mentionOff !== null && value[mentionOff] !== "@") setMentionOff(null);
					}}
					onPaste={onPaste}
					onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
						// 「@ 提及」面板开着：方向键 / Tab / Enter 归它用（Esc 只关面板，不动已经打的字）
						if (mention !== null && !event.nativeEvent.isComposing) {
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								const step = event.key === "ArrowDown" ? 1 : -1;
								const count = Math.max(1, mentionRows.length);
								setMentionActive((value) => (value + step + count) % count);
								return;
							}
							// 没有候选时 Enter 不该被吃掉：那就是「把这句话发出去」
							if ((event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) && mentionRows.length > 0) {
								event.preventDefault();
								const picked = mentionRows[mentionIndex];
								if (picked) pickMentionRow(picked);
								return;
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setMentionOff(mention.start);
								return;
							}
						}
						// 斜杠命令面板开着：方向键 / Tab / Enter 归它用（Esc 关掉面板，文本不动）
						if (slashOpen && !event.nativeEvent.isComposing) {
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								const step = event.key === "ArrowDown" ? 1 : -1;
								setSlashActive((value) => (value + step + Math.max(1, slashCount)) % Math.max(1, slashCount));
								return;
							}
							if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
								event.preventDefault();
								if (slashSkills !== null) {
									const picked = slashSkills[slashActive];
									if (picked) pickSkill(picked.name);
									return;
								}
								const picked = slashCommands[slashActive];
								if (picked) pickCommand(picked);
								return;
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setDraft("");
								return;
							}
						}
						if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
						event.preventDefault();
						// 回车默认：空闲时直接发；回合进行中默认「排队」（想插队再点「插队」）
						submit(running ? "queue" : "now");
					}}
					rows={1}
				/>
				<div className="composer-actions" ref={actionsRef}>
					{running && canSend ? (
						<>
							<button
								type="button"
								className="btn btn-send"
								title={t("等这一轮结束后再发（回车默认就是它）", "Send after this turn ends (the Enter default)")}
								onClick={() => submit("queue")}
							>
								{t("排队", "Queue")}
							</button>
							{/* 插队：只有底层协议真有 steer 语义的引擎才给这个按钮（ADR-0043）。
								   判断写成 `!== false` 而不是 `=== true`：
								   - 当前所有引擎都**显式**声明了 steer（pi true，codex/dsh/opencode false），所以语义不会歧义；
								   - 字段**缺失**只可能是「服务端还是老版本」，这时宁可先给按钮（服务端自己会降级成排队并提示），
								     也不要让人对着一个莫名其妙少了的按钮发愣（踩过：前端重建了、后端进程没重启）。 */}
							{snapshot?.engineCapabilities?.steer !== false ? (
								<button
									type="button"
									className="btn btn-queue"
									title={t(
										"插进当前这一轮（打断它，按新指示继续）",
										"Insert into the running turn (interrupt it, continue with new instructions)",
									)}
									onClick={() => submit("steer")}
								>
									{t("插队", "Steer")}
								</button>
							) : null}
							<button
								type="button"
								className="btn btn-stop"
								onClick={() => conversationId && interrupt(conversationId)}
							>
								{t("停止", "Stop")}
							</button>
						</>
					) : running ? (
						<button
							type="button"
							className="btn btn-stop"
							onClick={() =>
								conversationId && (surface ? surface.interrupt(conversationId) : interrupt(conversationId))
							}
						>
							{t("停止", "Stop")}
						</button>
					) : (
						<button
							type="button"
							className="btn btn-send"
							onClick={() => submit("now")}
							disabled={!canSend}
							title={
								draft.trim() === "" && notes !== ""
									? t(`把这 ${pendingNotes} 条注释发出去`, `Send these ${pendingNotes} note(s)`)
									: undefined
							}
						>
							➤ {t("发送", "Send")}
						</button>
					)}
				</div>
			</div>

			{galleryOpen ? (
				<TemplateGallery
					templates={templates}
					onEdit={(template) => setEditing({ template })}
					onCreate={() => setEditing({ template: null })}
					onClose={() => setGalleryOpen(false)}
				/>
			) : null}
			{editing ? (
				<TemplateEditor template={editing.template} library={templates} onClose={() => setEditing(null)} />
			) : null}
		</div>
	);
}
