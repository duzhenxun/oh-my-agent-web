/**
 * 「大弹窗」可调宽窄 / 高低（模型、技能、推送、插件、设置五个面板共用）。
 *
 * 为什么要自绘手柄：浏览器原生的 `resize` 只在右下角画一个小三角，深色主题下很扎眼，
 * 也没法双击复位、刷新后尺寸也留不住。这里自己挂一只右下角手柄：
 *   - 拖动改宽高（右下角往右/下变大）；
 *   - 双击手柄回到默认尺寸；
 *   - 尺寸存 localStorage（纯界面偏好，不进快照 —— 和侧栏宽度同一套纪律）。
 *
 * 约束：
 *   - 最小 620×340：再小就放不下「左列表 + 右详情」两栏了；
 *   - 最大不超过视口减一圈间距（拖出去就再也抓不回来）；
 *   - 手机壳（单栏）下**不写内联尺寸**：整屏铺满由 CSS 决定，内联会把它顶掉。
 *
 * 默认尺寸 = **满宽满高**（视口减去四周 --gap）：这几块面板都是两栏详情，
 * 内容永远比一屏高，小窗一打开就得拖、还得两头滚；干脆开满，用户觉得太大再往下拖。
 * 而且这份「开满」是**跟着视口算的**，不是存下来的值 —— 手动拖过才落到 localStorage。
 */
import { useCallback, useEffect, useState } from "react";
import { currentMobileShell } from "./mobile-shell-dom.ts";

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

type ModalSize = { width: number; height: number };
export type Viewport = { width: number; height: number };

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

export function useModalSize() {
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

	/** 拖右下角：pointer 事件挂 document（鼠标滑出手柄范围也不会中断） */
	const start = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			setPinned(true); // 从这一刻起尺寸归用户管（右键："我拖过了，记住它"）
			const startX = event.clientX;
			const startY = event.clientY;
			const startSize = size;
			const onMove = (moveEvent: PointerEvent) => {
				setSize(
					clampModalSize(
						{
							width: startSize.width + (moveEvent.clientX - startX),
							height: startSize.height + (moveEvent.clientY - startY),
						},
						viewport(),
					),
				);
			};
			const onUp = () => {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
		},
		[size],
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
