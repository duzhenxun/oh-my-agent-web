import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { basename } from "../path-utils.ts";
import { FileViewer } from "./FilePreview.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { SideChat } from "./SideChat.tsx";
import { WebTool } from "./WebTool.tsx";
import { FilesTool } from "./FilesTool.tsx";
import { FilesRail } from "./FilesRail.tsx";
import { useStoredBool } from "../use-stored-bool.ts";
import { hostOf } from "../url-bar.ts";
import { disposeSideChannel } from "../side-chat.ts";
import { useT } from "../use-language.ts";

/**
 * 右侧工作区面板里的一个标签。
 *
 * 五类：文件 / 终端 / 文件树 / 网页 / 临时聊天 —— 后三类是「分栏工作区」加进来的，
 * 前两类是原来就有的（消息里的 chip、侧栏「终端」按钮都还走它们）。
 */
export type PanelItem =
	| {
			id: string;
			kind: "file";
			path: string;
			root: string;
			/** 进来时先看哪个视图：从「改动过的文件」点进来就是 diff */
			mode?: "diff";
			/** 从全文搜索点进来：打开后滚到这一行并闪一下（1-based） */
			line?: number;
	  }
	| {
			id: string;
			kind: "terminal";
			cwd: string | null;
			/** 标签上显示的名字；不传就用 cwd 的最后一段（工作区目录名）/「终端」 */
			label?: string;
			/** 建好 PTY 后自动敲进去的命令（抬头「↑ 有新版」→ 安装走这里）；不传就是普通终端 */
			initialCommand?: string;
	  }
	/** 文件树（侧栏那套搬到右栏） */
	| { id: string; kind: "files" }
	/** 网页：地址栏 + iframe */
	| { id: string; kind: "web"; url: string }
	/** 临时聊天：每条标签一条独立通道（见 web/src/side-chat.ts）；不跨刷新恢复（见 preview-tabs-pref.ts） */
	| { id: string; kind: "side"; label?: string };

/** 落地页上能点的那四样工具 */
export type WorkTool = "files" | "terminal" | "side" | "web";

/**
 * 面板宽度（偏好记本机）。
 * key 带 `.v2`：默认值变过一次 —— 以前固定 620，现在「没存过就按中间那栏一样宽（一人一半）」，
 * 老 key 里的 620 会把这个新默认盖掉，所以换一个 key 让新默认生效一次。
 */
const WIDTH_KEY = "agent-web.preview.width.v2";
const MIN_WIDTH = 360;
const MAX_WIDTH = 1200;

/* ---- 「文件列表」那根侧栏的宽度（可拖那条竖线，偏好记本机） ---- */
const RAIL_WIDTH_KEY = "agent-web.preview.files-rail-w";
const RAIL_MIN_WIDTH = 140;
const RAIL_MAX_WIDTH = 520;
const RAIL_DEFAULT_WIDTH = 224;
/** 代码区至少留这么宽：面板不宽的时候，文件列表不能把内容挤成一条缝 */
const RAIL_MIN_CONTENT = 260;

function readRailWidth(): number {
	const raw = Number(localStorage.getItem(RAIL_WIDTH_KEY));
	if (!Number.isFinite(raw) || raw <= 0) return RAIL_DEFAULT_WIDTH;
	return Math.min(Math.max(raw, RAIL_MIN_WIDTH), RAIL_MAX_WIDTH);
}

/** 存过就用存的；没存过回 null —— 交给布局出来之后再按「跟中间那栏一样宽」算 */
function readWidth(): number | null {
	const raw = Number(localStorage.getItem(WIDTH_KEY));
	return Number.isFinite(raw) && raw >= MIN_WIDTH ? Math.min(raw, MAX_WIDTH) : null;
}

/** 标签上的图标与名字：五类各自一套，散在 JSX 里会难读 */
function tabTextOf(
	item: PanelItem,
	t: (zh: string, en: string) => string,
): { icon: string; label: string; title: string } {
	if (item.kind === "terminal") {
		return {
			icon: ">_",
			label: item.label ?? (item.cwd ? basename(item.cwd) || t("终端", "Terminal") : t("终端", "Terminal")),
			title: item.cwd ?? t("终端", "Terminal"),
		};
	}
	if (item.kind === "files") return { icon: "🗂", label: t("文件", "Files"), title: t("文件树", "File tree") };
	if (item.kind === "side") {
		return {
			icon: "💬",
			label: item.label ?? t("临时聊天", "Side chat"),
			title: t("临时聊天（不落盘）", "Side chat (not saved)"),
		};
	}
	if (item.kind === "web") {
		return {
			icon: "🌐",
			label: item.url ? hostOf(item.url) : t("新网页", "New page"),
			title: item.url || t("网页", "Web page"),
		};
	}
	const icon = /\.[jt]sx?$/i.test(item.path)
		? "TS"
		: /\.json$/i.test(item.path)
			? "{}"
			: /\.md$/i.test(item.path)
				? "M↓"
				: /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(item.path)
					? "IMG"
					: "▤";
	return { icon, label: basename(item.path) || item.path, title: item.path };
}

/**
 * 落地页的四张工具卡：**顺序就是用户定的**（2026-10-27）：
 * 临时聊天 → 终端 → 文件 → 网页。
 * 「临时聊天」最上面：它是「另开一条对话」—— 跟主对话最近的邻居，进来第一眼就要看到；
 * 「文件」排到终端下面：「翻文件」是看，而终端是敲，先能敲再看更顺手。
 */
const TOOL_CARDS: { tool: WorkTool; icon: string; zh: string; en: string; hintZh: string; hintEn: string }[] = [
	{
		tool: "side",
		icon: "💬",
		zh: "临时聊天",
		en: "Side chat",
		hintZh: "另开一条对话问一句就走，不落盘、不影响主会话",
		hintEn: "A separate throwaway chat: nothing saved, main session untouched",
	},
	{
		tool: "terminal",
		icon: ">_",
		zh: "终端",
		en: "Terminal",
		hintZh: "在当前工作区开一个 shell",
		hintEn: "Open a shell in the current workspace",
	},
	{
		tool: "files",
		icon: "🗂",
		zh: "文件",
		en: "Files",
		hintZh: "在当前工作区里翻文件，点开就在右边多一个标签",
		hintEn: "Browse the workspace; opened files land in a new tab",
	},
	{
		tool: "web",
		icon: "🌐",
		zh: "网页",
		en: "Web",
		hintZh: "输入网址直接在这儿看（有些站点拒绝被嵌入）",
		hintEn: "Open a URL right here (some sites refuse embedding)",
	},
];

/**
 * 右侧工作区面板：多标签 + 可收起 + 可拖宽（记住宽度）+ 可全屏。
 *
 * 没有标签时显示**落地页**（四个工具卡片），这样顶栏那颗分栏按钮点一下就有东西可点，
 * 不会打开一块空白。
 */
export function PreviewPanel({
	items,
	activeId,
	landing,
	onActivate,
	onCloseTabs,
	onReorder,
	onShowLanding,
	onPickTool,
	onToggleSplit,
	onWideChange,
	root,
	onOpenFile,
	onOpenFilePath,
	revealSeq = 0,
	onRevealFile,
	chatOnRight = false,
	showSplitButton = true,
}: {
	items: PanelItem[];
	activeId: string;
	/** 落地页（「+」或一条标签都没有时显示） */
	landing: boolean;
	onActivate: (id: string) => void;
	/** 关标签（右键菜单的「当前 / 左侧 / 右侧 / 全部」都走这一个口） */
	onCloseTabs: (ids: string[]) => void;
	/** 拖拽换序：直接给新的完整 id 顺序（只重排，不增不删） */
	onReorder: (ids: string[]) => void;
	/** 点「+」回到落地页（不关掉已有标签） */
	onShowLanding: () => void;
	onPickTool: (tool: WorkTool) => void;
	/** 「铺开」状态变化：外层据此把对话区让出来（只让中间两个区，左侧栏不动） */
	onWideChange?: (wide: boolean) => void;
	/**
	 * 收起整个分栏（= 顶栏那颗「分栏 / 收起」的同一个动作）。
	 * 面板升到顶栏那一行之后，这一排的最右端就落在标签条上了 —— 那颗按钮搬到这里，
	 * 面板拖得再宽也点得到（不然会滑到面板底下，收不回来）。
	 */
	onToggleSplit?: () => void;
	/** 文件树工具用：当前工作区 */
	root: string | null;
	onOpenFile: (path: string) => void;
	/**
	 * 预览里「路径对不上唯一文件」时点候选用：要带上**那个标签自己的根**
	 * （它可能不是当前会话的工作区 —— 从别的项目点进来的标签就属于别的根）。
	 */
	onOpenFilePath?: (path: string, root: string) => void;
	/** 从外面（打开文件）来的「把当前文件定位一下」信号：变化一次，右边那棵文件列表也跟着展开 + 选中 */
	revealSeq?: number;
	/** 「文件列表」那颗开关点开时：叫外面把左右两棵树都定位到当前文件（根不匹配时先切根） */
	onRevealFile?: (path: string, fileRoot: string) => void;
	/** 对话被换到右边了（面板在左）：拖宽的**方向**和图标里那道竖线都要跟着反过来 */
	chatOnRight?: boolean;
	/**
	 * 标签条右端那颗「收起分栏」要不要自己画。
	 * 对调时面板在左边，那颗按钮会落到窗口中线 —— 外层会把它补到顶栏最右端，
	 * 所以这一刻传 false（用户要求：这颗按钮永远在窗口右上角）。
	 */
	showSplitButton?: boolean;
}) {
	const t = useT();
	const [width, setWidth] = useState(() => readWidth() ?? 620);
	/**
	 * 第一次打开面板时**按「中间那栏一样宽」量一次**（用户要求：左右两块宽度差不多）。
	 * 面板挂载时它的父元素（`.right-upper`：对话 + 面板那一行）已经在 DOM 里，量它一半减去中间那道缝就行。
	 * 用 layout effect：在浏览器画之前就把宽度定好，不会先画一个 620 再跳到一半。
	 */
	const panelRef = useRef<HTMLAnchorElement | null>(null);
	const needHalfWidth = useRef(readWidth() === null);
	useLayoutEffect(() => {
		if (!needHalfWidth.current) return;
		needHalfWidth.current = false;
		const available = panelRef.current?.parentElement?.clientWidth ?? 0;
		if (available <= 0) return;
		const half = Math.round((available - 6) / 2); // 6 = 中间那道缝（分割线 + 边距）
		setWidth(Math.min(Math.max(half, MIN_WIDTH), MAX_WIDTH));
	}, []);
	/** 铺开：占满「对话 + 预览」两块区域（左侧栏仍然在），区别于整窗全屏 */
	const [wide, setWide] = useState(false);

	const setWideMode = (next: boolean) => {
		setWide(next);
		onWideChange?.(next);
	};
	const dragging = useRef(false);

	// 拖拽改宽：pointer 事件挂 document，鼠标移出面板也能继续
	const startResize = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			dragging.current = true;
			const startX = event.clientX;
			const startWidth = width;
			const onMove = (moveEvent: PointerEvent) => {
				if (!dragging.current) return;
				// 一条统一的规矩：**往左拖 = 右边那块变大**。
				//   面板在右（常态）：往左拖 → 面板变宽；
				//   面板在左（换边后）：往左拖 → 面板变窄、对话变宽。
				// 所以换边时位移要反号（以前不分边，换过去就变成“往左拖反而右边变小”了）。
				const delta = moveEvent.clientX - startX;
				const next = Math.min(Math.max(startWidth + (chatOnRight ? delta : -delta), MIN_WIDTH), MAX_WIDTH);
				setWidth(Math.round(next));
			};
			const onUp = () => {
				dragging.current = false;
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
		},
		[width, chatOnRight],
	);

	useEffect(() => {
		localStorage.setItem(WIDTH_KEY, String(width));
	}, [width]);

	const active = items.find((item) => item.id === activeId) ?? items[0];
	const showLanding = landing || items.length === 0;
	/**
	 * 看文件时右边那根「文件列表」侧栏：**默认关**（点页顶那颗「文件列表」按钮才开）。
	 * 关着的时候内容区能吃满整个面板宽度 —— 看代码时先要面，需要翻文件时再点开。
	 *
	 * key 换了两次，每次都是因为**默认值变过**：先用过默认开（`.v2`），用户看过之后要求改回默认关，
	 * 于是抬到 `.v3` —— 否则之前默认开着时写进 localStorage 的 `1` 会一直盖住新默认值。
	 * 之后手动开关照样记住（默认值只该管「没选过」的时候）。
	 */
	const [filesRail, setFilesRail] = useStoredBool("agent-web.preview.files-rail.v3", false);
	/** 文件列表侧栏的宽度：拖它左边那条竖线就能调（双击复位），偏好记本机 */
	const [railWidth, setRailWidth] = useState(readRailWidth);
	useEffect(() => {
		localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth));
	}, [railWidth]);
	/**
	 * 拖那条竖线调宽度。
	 * 文件列表在**右边**，所以「往左拖 = 变宽」；上限再按面板自己的宽度收一道 ——
	 * 否则面板本来就不宽的时候，文件列表会把代码区挤成一条缝。
	 */
	const startRailResize = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			const startX = event.clientX;
			const startWidth = railWidth;
			const ceiling = Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, width - RAIL_MIN_CONTENT));
			const onMove = (moveEvent: PointerEvent) => {
				const next = Math.min(Math.max(startWidth + (startX - moveEvent.clientX), RAIL_MIN_WIDTH), ceiling);
				setRailWidth(Math.round(next));
			};
			const onUp = () => {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
		},
		[railWidth, width],
	);
	// 只有「正在看一个文件」时才有意义：终端 / 网页 / 临时聊天旁边不需要文件树
	const activeFile = !showLanding && active?.kind === "file" ? active : null;
	/**
	 * 终端当主角时给面板加个类：面板那圈浅色内边距和行间距要收掉，让黑色铺到四条边。
	 * 终端自带的底色是 #0d1117，嵌在 6px 浅色留白里就成了「黑块泡在白框里」——
	 * 具体样式见 preview-panel.css 的 `.preview-panel-term`。
	 */
	const terminalActive = !showLanding && active?.kind === "terminal";
	/**
	 * 「文件列表」那颗开关：挂在**文件头**里（`FileViewer` 的 toolbar 插槽），不放标签条。
	 * 理由：标签条那一排讲的是「开了哪些标签」，而这是「这个文件旁边要不要再来一根文件树」——
	 * 它是这个文件视图的选项，跟「源码 / 预览 / 改动」同一类，就该跟它们挤在一行。
	 * 默认**关**（`filesRail` 的初值），点一下才在右边常驻。**开的那一刻顺手定位**：
	 * 让左右两棵树都展开到当前这个文件（根不匹配时先切根），最后把那一行选上。
	 */
	const filesRailToggle = (
		<button
			type="button"
			className={`btn btn-tiny preview-tool-btn${filesRail ? " btn-wide-on" : ""}`}
			onClick={() => {
				const next = !filesRail;
				setFilesRail(next);
				if (next && activeFile) onRevealFile?.(activeFile.path, activeFile.root || root || "");
			}}
			aria-pressed={filesRail}
			title={
				filesRail
					? t("隐藏右边那排文件列表", "Hide the file list on the right")
					: t("显示文件列表（常驻在内容右边，点文件另开标签）", "Show the file list (opens files as new tabs)")
			}
		>
			{/* 三条横线 + 小方框：一个「列表」的意思，跟全屏/铺开那两颗区分开 */}
			<svg className="preview-tool-icon" viewBox="0 0 16 16" aria-hidden="true">
				<path d="M2 3.6h7M2 8h7M2 12.4h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
				<rect x="11.2" y="3.6" width="3" height="8.8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
			</svg>
		</button>
	);

	/**
	 * 标签拖拽换序。
	 *
	 * 做法是最土也最稳的那种：按住移动超过 5px 才开始拖，每次移动都按**指针位置**算目标槽位，
	 * 直接把新顺序报给外层（不自己存一份镜像）—— 拖动中就能看到标签真的在让位。
	 * 没拖动过的按下 → 松手时当作「点了一下」，所以标签不用再绑 onClick。
	 */
	const stripRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ id: string; startX: number; moved: boolean } | null>(null);
	const [draggingId, setDraggingId] = useState<string | null>(null);

	/**
	 * 标签条横向滑：标签**不压缩**（每个都保持自己的宽度，否则挤成一排省略号，看不出是哪个），
	 * 放不下就滚。这里补两件事，让「能滑」真的好玩起来：
	 *  - 鼠标滚轮竖着滚 = 横着滑（普通鼠标没有横向滚轮，触控板则本来就双指左右）；
	 *    必须用原生监听 + `passive: false`，否则 preventDefault 无效（ React 在根上注册的 wheel 是 passive 的）。
	 *  - 切 / 开标签时把活动那颗滚进可见区（否则从菜单或文件列表开的新标签落在看不见的地方）。
	 */
	useEffect(() => {
		const strip = stripRef.current;
		if (!strip) return;
		const onWheel = (event: WheelEvent) => {
			// 没溢出就不接管，页面 / 面板照旧滚
			if (strip.scrollWidth <= strip.clientWidth + 1) return;
			// 触控板横向手势（deltaX 更大）交给浏览器自己滑，不要再叠一遍
			if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
			strip.scrollLeft += event.deltaY;
			event.preventDefault();
		};
		strip.addEventListener("wheel", onWheel, { passive: false });
		return () => strip.removeEventListener("wheel", onWheel);
	}, []);

	/** 活动标签滚进可见区（切标签 / 新开一个标签 / 关掉旁边那个之后都要） */
	useEffect(() => {
		const strip = stripRef.current;
		if (!strip || !active) return;
		const tab = strip.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active.id)}"]`);
		if (!tab) return;
		// 自己算偏移，不用 scrollIntoView：后者可能连带把页面 / 面板竖向也滚一下
		const box = strip.getBoundingClientRect();
		const rect = tab.getBoundingClientRect();
		if (rect.left < box.left) strip.scrollLeft -= box.left - rect.left + 6;
		else if (rect.right > box.right) strip.scrollLeft += rect.right - box.right + 6;
	}, [active?.id, items.length]);

	const endDrag = (pointerId?: number) => {
		const drag = dragRef.current;
		dragRef.current = null;
		setDraggingId(null);
		if (pointerId === undefined) return;
		const strip = stripRef.current;
		// setPointerCapture 在元素被重排（React 重渲染换了节点）后会失效：这里主动释放一下
		for (const element of strip?.querySelectorAll("[data-tab-id]") ?? []) {
			if ((element as HTMLElement).hasPointerCapture?.(pointerId))
				(element as HTMLElement).releasePointerCapture(pointerId);
		}
		return drag;
	};

	/** 指针横坐标 → 应该插到第几号槽位（以兄弟标签的中线为界） */
	const targetIndexAt = (clientX: number): number => {
		const strip = stripRef.current;
		if (!strip) return items.length - 1;
		const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]"));
		for (let index = 0; index < tabs.length; index += 1) {
			const rect = tabs[index].getBoundingClientRect();
			if (clientX < rect.left + rect.width / 2) return index;
		}
		return tabs.length - 1;
	};

	const onTabPointerDown = (event: React.PointerEvent<HTMLElement>, id: string) => {
		if (event.button !== 0) return;
		// 点在「×」上：那是关闭，不在它身上起拖拽
		if ((event.target as HTMLElement).closest(".preview-tab-x")) return;
		/**
		 * 触屏：**不接管指针**。手机上一排标签装不下时，手指横滑就该让标签条左右滑
		 * （`.preview-tabs-strip` 的 overflow-x，`touch-action: pan-x`），
		 * 接管成拖拽排序的话，手势全被吃掉，看起来就是「标签滑不动」。
		 * 松开没位移仍然当点击（见 onTabPointerUp），拖起来之后浏览器会发 pointercancel，
		 * 不会误切标签。鼠标 / 笔不受影响，照旧拖拽换序。
		 */
		if (event.pointerType === "touch") return;
		dragRef.current = { id, startX: event.clientX, moved: false };
		(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
	};

	const onTabPointerMove = (event: React.PointerEvent<HTMLElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		if (!drag.moved) {
			if (Math.abs(event.clientX - drag.startX) < 5) return;
			drag.moved = true;
			setDraggingId(drag.id);
		}
		const ids = items.map((item) => item.id);
		const from = ids.indexOf(drag.id);
		const target = targetIndexAt(event.clientX);
		if (from < 0) return;
		// 指针落在「自己右边」时，抽出自己后目标槽位会往左退一格
		const insertAt = target > from ? target - 1 : target;
		if (insertAt === from) return;
		const next = [...ids];
		next.splice(from, 1);
		next.splice(insertAt, 0, drag.id);
		onReorder(next);
	};

	const onTabPointerUp = (event: React.PointerEvent<HTMLElement>, id: string) => {
		const drag = dragRef.current;
		const moved = drag?.moved === true;
		endDrag(event.pointerId);
		// 没拖动过 = 一次普通点击：切到这个标签
		if (!moved) onActivate(id);
	};

	/**
	 * 右键菜单：关当前 / 关左侧 / 关右侧 / 关全部（替代原来那个右上角「✕ 关闭全部」——
	 * 那颗按钮太容易被当成「关掉整个分栏」，而且只给了一个维度的选择）。
	 */
	const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

	useEffect(() => {
		if (!menu) return;
		const close = (event: Event) => {
			// 点在菜单自身上的那一下不能关：否则 pointerdown 先把菜单卸了，click 就永远轮不到
			if ((event.target as HTMLElement | null)?.closest?.(".preview-tab-menu")) return;
			setMenu(null);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenu(null);
		};
		// 捕获阶段关：点菜单项时也要先关掉菜单（不然它会浮在下一帧的界面上）
		window.addEventListener("pointerdown", close, true);
		window.addEventListener("keydown", onKey);
		window.addEventListener("blur", close);
		return () => {
			window.removeEventListener("pointerdown", close, true);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("blur", close);
		};
	}, [menu]);

	const menuIndex = menu ? items.findIndex((item) => item.id === menu.id) : -1;
	const menuItems =
		menuIndex < 0
			? []
			: [
					{ key: "one", zh: "关闭", en: "Close", ids: [items[menuIndex].id], disabled: false },
					{
						key: "left",
						zh: "关闭左侧标签",
						en: "Close tabs to the left",
						ids: items.slice(0, menuIndex).map((item) => item.id),
						disabled: menuIndex === 0,
					},
					{
						key: "right",
						zh: "关闭右侧标签",
						en: "Close tabs to the right",
						ids: items.slice(menuIndex + 1).map((item) => item.id),
						disabled: menuIndex === items.length - 1,
					},
					{ key: "all", zh: "关闭全部标签", en: "Close all tabs", ids: items.map((item) => item.id), disabled: false },
				];

	return (
		<aside
			ref={panelRef}
			className={`preview-panel${wide ? " preview-panel-wide" : ""}${terminalActive ? " preview-panel-term" : ""}`}
			style={wide ? undefined : { width }}
		>
			<div className="preview-resizer" onPointerDown={startResize} title={t("拖动调整宽度", "Drag to resize")} />
			<div className="preview-tabs">
				{/* 标签都装在里层：只有这一层横向滚 —— 右边的工具按钮（文件列表 / 全屏 / 分栏）
				 * 跟「＋」要一直留在原地，不能跟着标签一起被推出去 */}
				<div className="preview-tabs-strip" ref={stripRef}>
					{items.map((item) => {
						const { icon, label, title } = tabTextOf(item, t);
						return (
							<span
								className={`preview-tab${item.id === active?.id && !showLanding ? " preview-tab-on" : ""}${
									draggingId === item.id ? " preview-tab-dragging" : ""
								}`}
								key={item.id}
								data-tab-id={item.id}
								onPointerDown={(event) => onTabPointerDown(event, item.id)}
								onPointerMove={onTabPointerMove}
								onPointerUp={(event) => onTabPointerUp(event, item.id)}
								onPointerCancel={(event) => endDrag(event.pointerId)}
								onContextMenu={(event) => {
									event.preventDefault();
									setMenu({ x: event.clientX, y: event.clientY, id: item.id });
								}}
							>
								{/* 键盘也能切：指针已经由 pointerup 处理（那里能区分「拖」和「点」），
							    所以这里只接 detail===0 的合成点击（回车 / 空格） */}
								<button
									type="button"
									className="preview-tab-name"
									title={title}
									onClick={(event) => {
										if (event.detail === 0) onActivate(item.id);
									}}
								>
									<span className="preview-tab-icon">{icon}</span>
									{label}
								</button>
								<button
									type="button"
									className="preview-tab-x"
									onClick={() => onCloseTabs([item.id])}
									title={t("关闭", "Close")}
								>
									×
								</button>
							</span>
						);
					})}
				</div>
				{/* 「+」：回到落地页挑工具（标签都留着，挑完接着开新标签） */}
				<button
					type="button"
					className="preview-tab-add"
					onClick={onShowLanding}
					title={t("新标签（文件 / 终端 / 临时聊天 / 网页）", "New tab (files / terminal / side chat / web)")}
				>
					{/* 用 SVG 画「＋」而不是字符：字符的墨迹只有同号图标的三分之二宽，
					    跟旁边那两颗按钮并排时怎么看都偏窄（用户提的）。 */}
					<svg className="preview-tab-add-icon" viewBox="0 0 16 16" aria-hidden="true">
						<path d="M8 2.4v11.2M2.4 8h11.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
					</svg>
				</button>
				<span className="topbar-spacer" />
				<button
					type="button"
					className={`btn btn-tiny preview-tool-btn${wide ? " btn-wide-on" : ""}`}
					onClick={() => setWideMode(!wide)}
					title={wide ? "收回右侧（恢复对话区）" : "铺开：占满对话 + 预览两块区域（左侧栏保留）"}
					aria-pressed={wide}
				>
					{/* 两侧箭头 + 竖线：表示「把中间两块铺满」。
					 * 墨迹范围刻意画成跟旁边「分栏」那个方框一样大（约 11.6×8）：只按字形自然大小画的话，
					 * 同一个按钮里这颗会显得比邻座小一圈，看着像两套图标。 */}
					<svg className="preview-wide-icon" viewBox="0 0 16 16" aria-hidden="true">
						<path d="M2.2 4v8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
						<path d="M6.2 8h7.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
						<path
							d="m10.6 5.5 2.8 2.5-2.8 2.5"
							stroke="currentColor"
							strokeWidth="1.4"
							fill="none"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
						<path
							d="m7.8 5.5-2.8 2.5 2.8 2.5"
							stroke="currentColor"
							strokeWidth="1.4"
							fill="none"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
				{/*
				 * 「分栏 / 收起」：面板升到顶栏那一行之后，这一排的最右端就是这里 ——
				 * 所以顶栏那颗搬到了这儿（动作是同一个 onToggleSplit），面板拖多宽都点得到。
				 * 图标跟顶栏那颗一致（左大右小的两块），尺寸跟旁边两颗小方块一致。
				 */}
				{onToggleSplit && showSplitButton ? (
					<button
						type="button"
						className="btn btn-tiny preview-tool-btn"
						onClick={onToggleSplit}
						title={
							chatOnRight
								? t("收起左侧工作区（分栏）", "Collapse the left work area (split)")
								: t("收起右侧工作区（分栏）", "Collapse the right work area (split)")
						}
					>
						<svg className="preview-tool-icon" viewBox="0 0 16 16" aria-hidden="true">
							<rect
								x="2.2"
								y="4"
								width="11.6"
								height="8.2"
								rx="1.8"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.3"
							/>
							{/* 竖线标的是**面板在哪一侧**：换边后画到左边，否则图标说的是“右边那块”，
							    实际收起的却是左边那块 */}
							<line
								x1={chatOnRight ? "6" : "10"}
								y1="4"
								x2={chatOnRight ? "6" : "10"}
								y2="12.2"
								stroke="currentColor"
								strokeWidth="1.3"
							/>
						</svg>
					</button>
				) : null}
			</div>
			{/* 标签右键菜单：固定定位沿指针位置，夹进视口（靠近右/下边也不会跑出屏幕） */}
			{menu ? (
				<div
					className="preview-tab-menu"
					role="menu"
					style={{
						left: Math.max(8, Math.min(menu.x, window.innerWidth - 200)),
						top: Math.max(8, Math.min(menu.y, window.innerHeight - 160)),
					}}
				>
					{menuItems.map((entry) => (
						<button
							key={entry.key}
							type="button"
							role="menuitem"
							className="preview-tab-menu-item"
							disabled={entry.disabled}
							onClick={() => {
								setMenu(null);
								onCloseTabs(entry.ids);
							}}
						>
							{t(entry.zh, entry.en)}
						</button>
					))}
				</div>
			) : null}
			<div className="preview-body">
				{showLanding ? (
					<div className="work-landing">
						<div className="work-landing-head">{t("工具", "Tools")}</div>
						<div className="work-landing-grid">
							{TOOL_CARDS.map((card) => (
								<button
									type="button"
									className="work-tool-card"
									key={card.tool}
									onClick={() => onPickTool(card.tool)}
									title={t(card.hintZh, card.hintEn)}
								>
									<span className="work-tool-icon">{card.icon}</span>
									<span className="work-tool-label">{t(card.zh, card.en)}</span>
									<span className="work-tool-hint">{t(card.hintZh, card.hintEn)}</span>
								</button>
							))}
						</div>
					</div>
				) : null}
				{/* 全部渲染、只隐藏非激活的：切标签时组件不卸载，终端的 PTY、网页的历史、
				    临时聊天的连接与滚动位置都保住（之前只渲染激活项，一切换就触发 stop → "进程已退出"） */}
				{items.map((item) => (
					<div
						className={`preview-slot${item.id === active?.id && !showLanding ? "" : " preview-slot-hidden"}`}
						key={item.id}
					>
						{item.kind === "file" ? (
							<FileViewer
								path={item.path}
								root={item.root}
								initialMode={item.mode ?? null}
								focusLine={item.line}
								toolbar={filesRailToggle}
								onOpenPath={onOpenFilePath ? (next) => onOpenFilePath(next, item.root) : undefined}
							/>
						) : item.kind === "terminal" ? (
							<TerminalPanel
								termId={item.id}
								cwd={item.cwd}
								initialCommand={item.initialCommand ?? null}
								active={item.id === active?.id && !showLanding}
								onClose={() => onCloseTabs([item.id])}
							/>
						) : item.kind === "files" ? (
							<FilesTool root={root} onOpenFile={onOpenFile} />
						) : item.kind === "web" ? (
							<WebTool initialUrl={item.url} />
						) : (
							<SideChat itemId={item.id} />
						)}
					</div>
				))}
				{/* 文件列表侧栏：跟在所有槽位后面（右侧面板贴窗口右边，所以树在最右、内容在它左边） */}
				{/* 竖线本身也是把手：往左拖 = 文件列表变宽（双击回到默认宽度） */}
				{activeFile && filesRail ? (
					<>
						<div
							className="preview-files-resizer"
							role="separator"
							aria-orientation="vertical"
							title={t("拖动调整文件列表宽度（双击复位）", "Drag to resize the file list (double-click to reset)")}
							onPointerDown={startRailResize}
							onDoubleClick={() => setRailWidth(RAIL_DEFAULT_WIDTH)}
						/>
						<FilesRail
							/* 根跟**正在看的这个文件**走：从内容/文件搜索打开别的项目的文件时，
							   右边这棵树也得是那个项目，否则一样定位不到 */
							root={activeFile.root || root}
							activePath={activeFile.path}
							revealSeq={revealSeq}
							onOpenFile={onOpenFile}
							width={railWidth}
						/>
					</>
				) : null}
			</div>
		</aside>
	);
}

/** 关掉一条临时聊天时顺手断开它那条通道（否则 SSE 会一直挂着） */
export function disposePanelItem(item: PanelItem): void {
	if (item.kind === "side") disposeSideChannel(item.id);
}
