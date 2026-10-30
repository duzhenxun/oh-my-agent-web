/**
 * 「大弹窗」可调宽窄 / 高低（模型、技能、推送、插件、设置五个面板共用）。
 *
 * 为什么要自绘手柄：浏览器原生的 `resize` 只在右下角画一个小三角，深色主题下很扎眼，
 * 也没法双击复位、刷新后尺寸也留不住。这里自己挂四只手柄（四个角都能拖）：
 *   - 拖动改宽高（拖哪个角，**对面的角就不动**）；
 *   - 双击手柄回到默认尺寸（连带位置复位）；
 *   - 尺寸存 localStorage（纯界面偏好，不进快照 —— 和侧栏宽度同一套纪律）。
 *
 * 「对面的角不动」怎么做到：`:modal-backdrop` 是 flex 居中的，宽高一变，两边各让一半。
 * 所以改完尺寸再让位置补一半（`ResizeAnchor`，由 `useModalMove` 提供）——
 * 拖左上角往右下拖时，右下角就稳稳地钉在原地。
 *
 * 约束：
 *   - 最小 620×340：再小就放不下「左列表 + 右详情」两栏了；
 *   - 最大不超过视口减一圈间距（拖出去就再也抓不回来）；
 *   - **整块得在视口里**：光夹宽高不够 —— 拖右下角时左边是不动的，面板就会一路长到窗口外面去
 *     （用户 2026-10-30 的截图：设置面板一半在屏幕外）。所以算完尺寸还要按当前位置把整块夹回来
 *     （`clampModalPos`，严格那一档）；
 *   - 手机壳（单栏）下**不写内联尺寸**：整屏铺满由 CSS 决定，内联会把它顶掉。
 *
 * 默认尺寸 = **满宽满高**（视口减去四周 --gap）：这几块面板都是两栏详情，
 * 内容永远比一屏高，小窗一打开就得拖、还得两头滚；干脆开满，用户觉得太大再往下拖。
 * 而且这份「开满」是**跟着视口算的**，不是存下来的值 —— 手动拖过才落到 localStorage。
 */
import { useCallback, useEffect, useState } from "react";
import { currentMobileShell } from "./mobile-shell-dom.ts";
import { clampModalPos } from "./use-modal-move.ts";

/**
 * 尺寸的存储键。**带版本号**：默认尺寸一改，老用户 localStorage 里那份旧值会把新默认盖掉，
 * 界面上看就是「改了没生效」。
 * v4 = 默认改成**跟随视口铺满**，而且**只在手动拖过之后才存**（v3 会在 resize 时把夹小的尺寸写回去，
 * 于是窗口再放大也还是那个小弹窗）；v3 是满宽满高但无脑持久化，v2 是宽 1120 封顶、v1 是写死 760px。
 */
const MODAL_SIZE_KEY = "agent-web:big-modal-size:v4";
/** 旧键：只在第一次打开时清掉，免得老尺寸（尤其是拖小的、或被 resize 夹小的那份）继续生效 */
const LEGACY_MODAL_SIZE_KEYS = [
	"agent-web:big-modal-size",
	"agent-web:big-modal-size:v2",
	"agent-web:big-modal-size:v3",
];
const MIN_MODAL_WIDTH = 620;
const MIN_MODAL_HEIGHT = 340;
/** 与 CSS 的 --gap 对齐：四周留一圈，别贴着视口边缘 */
const VIEWPORT_MARGIN = 16;

export type ModalSize = { width: number; height: number };
export type Viewport = { width: number; height: number };

/** 四只手柄，名字就是它们所在的角（s/n + e/w） */
export type ModalCorner = "nw" | "ne" | "sw" | "se";

/**
 * 调尺寸时推动位置，让「对面的角」不动（`use-modal-move.ts` 实现）。
 *
 * `begin`：手势开始时确认位置，并**把手势开始时的位移交回去**（算视野要用）；
 * `shift`：相对那个位置该平移多少（从手势开始累计）；
 * `commit`：松手时把新位置落盘（和拖动头部同一份存储）。
 */
export type ResizeAnchor = {
	begin: () => { x: number; y: number };
	shift: (delta: { x: number; y: number }) => void;
	commit: () => void;
};

const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** 纯函数：当前视口下允许的范围（视口比最小值还小时，最小值优先 —— 宁可溢出也别挤成零宽） */
function modalSizeBounds(view: Viewport) {
	return {
		minWidth: MIN_MODAL_WIDTH,
		minHeight: MIN_MODAL_HEIGHT,
		maxWidth: Math.max(MIN_MODAL_WIDTH, view.width - VIEWPORT_MARGIN * 2),
		maxHeight: Math.max(MIN_MODAL_HEIGHT, view.height - VIEWPORT_MARGIN * 2),
	};
}

/**
 * 纯函数：默认尺寸 —— **宽高都顶满可用区**（视口减去四周的 --gap）。
 *
 * 早先宽度封在 1120px：在 2K/4K 屏上只占中间一块，两边全是背景；
 * 这几块面板（模型 / 技能 / 推送 / 插件 / MCP / 子代理 / 设置）都是「左列表 + 右详情」两栏，
 * 宽度给了用得上（模型名、路径、描述都很长），高度本来就不够。所以默认直接开满，
 * 觉得太大了再拖右下角，双击手柄可以回到这个默认。
 */
function defaultModalSize(view: Viewport): ModalSize {
	const bounds = modalSizeBounds(view);
	return {
		width: Math.round(bounds.maxWidth),
		height: Math.round(bounds.maxHeight),
	};
}

/** 纯函数：夹回合法范围（窗口缩小、存了个离谱的值、拖到视口外都走这里） */
function clampModalSize(size: ModalSize, view: Viewport): ModalSize {
	const bounds = modalSizeBounds(view);
	const width = Number.isFinite(size.width) ? size.width : defaultModalSize(view).width;
	const height = Number.isFinite(size.height) ? size.height : defaultModalSize(view).height;
	return {
		width: Math.round(clamp(width, bounds.minWidth, bounds.maxWidth)),
		height: Math.round(clamp(height, bounds.minHeight, bounds.maxHeight)),
	};
}

/**
 * 纯函数：拖某一个角之后的新尺寸 + 位置要补的位移（见 `ResizeAnchor`）。
 *
 * 位移的符号按「对面那个角钉住」推出来：
 *   - 拖东侧的角（se / ne）锚左边的角 → 宽的变化由位置让一半（dx > 0，即变小 → 位置往右）；
 *   - 拖西侧的角（sw / nw）锚右边的角 → 反过来；上下同理。
 * 两步夹取，顺序不能换：
 *   1. 先夹**尺寸**（最小尺寸 / 视口减两圈间距）；
 *   2. 再夹**整块的位置**（严格那一档）—— 这一步才是「不许长到窗口外面去」。
 *      没有它：面板在右半边时拖右下角，左边钉住不动 → 右边一路长到屏幕外，
 *      存进 localStorage 之后，下次打开就是这个「半个弹窗」的样子。
 */
export function resizeFromCorner(input: {
	start: ModalSize;
	/** 当前位移（`useModalMove` 那份；居中布局下 0 就是正中间） */
	pos: { x: number; y: number };
	dx: number;
	dy: number;
	corner: ModalCorner;
	view: Viewport;
}): { size: ModalSize; shift: { x: number; y: number } } {
	const horizontal = input.corner === "se" || input.corner === "ne" ? 1 : -1;
	const vertical = input.corner === "se" || input.corner === "sw" ? 1 : -1;
	const size = clampModalSize(
		{
			width: input.start.width + horizontal * input.dx,
			height: input.start.height + vertical * input.dy,
		},
		input.view,
	);
	const anchored = {
		x: input.pos.x + (horizontal * (size.width - input.start.width)) / 2,
		y: input.pos.y + (vertical * (size.height - input.start.height)) / 2,
	};
	const next = clampModalPos(anchored, size, input.view);
	// `0` 而不是 `-0`：夹取时差值是 0，乘上方向会变成负零（无害，但单测里很难看）
	const shiftX = Math.round(next.x - input.pos.x);
	const shiftY = Math.round(next.y - input.pos.y);
	return {
		size,
		shift: { x: shiftX === 0 ? 0 : shiftX, y: shiftY === 0 ? 0 : shiftY },
	};
}

/** 纯函数：从 localStorage 读尺寸（没存过 / 坏值 → 默认尺寸） */
function readStoredModalSize(raw: string | null, view: Viewport): ModalSize {
	if (!raw) return defaultModalSize(view);
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return defaultModalSize(view);
		const record = parsed as { width?: unknown; height?: unknown };
		if (typeof record.width !== "number" || typeof record.height !== "number") return defaultModalSize(view);
		if (!Number.isFinite(record.width) || !Number.isFinite(record.height)) return defaultModalSize(view);
		return clampModalSize({ width: record.width, height: record.height }, view);
	} catch {
		return defaultModalSize(view);
	}
}

export function useModalSize(options?: { anchor?: { current: ResizeAnchor | null } }) {
	const anchorRef = options?.anchor;
	const [size, setSize] = useState<ModalSize>(() => {
		for (const key of LEGACY_MODAL_SIZE_KEYS) localStorage.removeItem(key); // 换了键就没人读了，清掉
		return readStoredModalSize(localStorage.getItem(MODAL_SIZE_KEY), viewport());
	});
	const [mobile, setMobile] = useState(currentMobileShell);
	/**
	 * 是否「用户亲手定过尺寸」。
	 * 没定过 = 跟着视口走（窗口拉多大就弹多大）；定过 = 尊重拖出来的尺寸，只做夹取。
	 * 关键：**没定过就不写 localStorage** —— 以前 resize 时把夹小的尺寸写回去，
	 * 结果在大窗口里也是那个小弹窗，看着就像「默认又变小了」。
	 */
	const [pinned, setPinned] = useState(() => localStorage.getItem(MODAL_SIZE_KEY) !== null);

	useEffect(() => {
		if (!pinned) return;
		localStorage.setItem(MODAL_SIZE_KEY, JSON.stringify(size));
	}, [pinned, size]);

	// 窗口变小 / 变大 / 从双栏切到单栏：尺寸跟着走
	//   - 没拖过：重新按当前视口算「满宽满高」（拉大窗口也跟着变大）
	//   - 拖过：夹回合法范围（否则弹窗会有一半在屏幕外）
	useEffect(() => {
		const onResize = () => {
			setMobile(currentMobileShell());
			setSize((current) => (pinned ? clampModalSize(current, viewport()) : defaultModalSize(viewport())));
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [pinned]);

	/**
	 * 拖四个角之一：pointer 事件挂 document（鼠标滑出手柄范围也不会中断）。
	 *
	 * 宽高变化的方向由 corner 决定；同时把**一半**的变化量交给位置（面板居中，两边各让一半），
	 * 这样对面的角就固定在原地 —— 不补这一下，拖左上角时面板会以中心为轴两边一起长，
	 * 手感像“拖了一半”。
	 */
	const start = useCallback(
		(event: React.PointerEvent<HTMLDivElement>, corner: ModalCorner = "se") => {
			event.preventDefault();
			setPinned(true); // 从这一刻起尺寸归用户管（右键："我拖过了，记住它"）
			const anchor = anchorRef?.current ?? null;
			const startPos = anchor?.begin() ?? { x: 0, y: 0 };
			const startX = event.clientX;
			const startY = event.clientY;
			const startSize = size;
			const onMove = (moveEvent: PointerEvent) => {
				const { size: next, shift } = resizeFromCorner({
					start: startSize,
					pos: startPos,
					dx: moveEvent.clientX - startX,
					dy: moveEvent.clientY - startY,
					corner,
					view: viewport(),
				});
				setSize(next);
				anchor?.shift(shift);
			};
			const onUp = () => {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
				anchor?.commit();
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
		},
		[size, anchorRef],
	);

	/** 双击手柄：回到「跟着视口铺满」，并且**把存的那份删掉**（否则下次打开还是旧的） */
	const reset = useCallback(() => {
		localStorage.removeItem(MODAL_SIZE_KEY);
		setPinned(false);
		setSize(defaultModalSize(viewport()));
	}, []);

	return {
		size,
		/** 手机壳下留空：整屏铺满交给 CSS */
		style: mobile ? undefined : { width: `${size.width}px`, height: `${size.height}px` },
		start,
		reset,
	};
}
