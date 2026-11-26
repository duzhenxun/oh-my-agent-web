/**
 * 右下角的**朗读小宠物**：实时朗读在念的时候它就在说话。
 *
 * 用户 2026-11-24 的几轮修改合成现在的样子：
 *   「你重写一个动物的小宠物放右边都行，让他发声」→「宠物也能拖…并记住位置」→
 *   「拖到边缘自动吸边…吸附成一个小半圆」→「停止时不要给他关掉呀.还要要有一个暂停,
 *   发音的位置看着不对.不好看. 你弄大点,透明的就可以」。
 *
 * 所以现在的规矩：
 *   - **常驻**：不再「没在念就整个不画」——点「停止」之后它留在原地，只是安静下来（`is-idle`），
 *     想再听就再点尾巴那颗「朗读」。位置/尺寸变了也不会突然跳一下；
 *   - **两颗明确的按钮**：`暂停 / 继续` 和 `停止`（不靠「点头 = 暂停」这种隐藏手势 ——
 *     那个还留着，但不再是唯一入口）。没在念时两颗都置灰；
 *   - **发声的位置在正中央**：三圈声波从宠物身上**向外扩散**（不是挤在脸旁边的三条竖杠，
 *     那个位置看着偏、也不好看）；
 *   - **大一号、透明**：64px 的圆，底色只有很淡的一层（45%），不挡字；
 *   - 拖到任意位置并记住；松手时贴边（28px 内）吸附成**半个圆**；双击回默认位。
 *
 * 为什么用 emoji 而不是画一套 SVG：一个只会「说话 / 睡着 / 发呆」三态的小家伙，emoji 够用，
 * 省掉素材也不占体积；动效与吸边形状全在 CSS 里。
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { readStored, writeStored } from "../ui-prefs.ts";
import { ProjectMenuPopover, type MenuPoint } from "./ProjectMenuPopover.tsx";
import { requestOpenPanel } from "../open-panel.ts";
import { requestStopSpeech, setSpeechPaused, useReading, useSpeechPaused } from "../speech-control.ts";
import { PET_ENABLED_KEY, usePetAnimal, writePetEnabled } from "../speech-pet-prefs.ts";
import { useStoredBool } from "../use-stored-bool.ts";
import { useT } from "../use-language.ts";

/** 位置存储键（第一次拖过之后才有值；清掉它就回默认位） */
const POS_KEY = "agent-web.speech.pet.pos.v1";
/** 至少留这么多像素在视口内：拖出去之后还抓得回来 */
const EDGE = 8;
/** 超过这么多像素才算「拖」，否则当成「点」（手指轻点会抖 1-2px） */
const DRAG_THRESHOLD = 4;
/** 离屏幕边这么近就吸上去 */
const SNAP = 28;

/** 吸在哪条边上（贴边时形状变成半个圆，见 CSS 的 `.is-docked-*`） */
type Side = "left" | "right" | "top" | "bottom";
type Place = { x: number; y: number; docked: Side | null };
type Size = { width: number; height: number };
type Viewport = { width: number; height: number };

const SIDES: readonly Side[] = ["left", "right", "top", "bottom"];

/** 读上次拖到的位置；坏数据（手改过 / 旧格式）当没存过 */
function readPlace(): Place | null {
	const raw = readStored(POS_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<Place>;
		if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
		if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
		const docked = SIDES.includes(parsed.docked as Side) ? (parsed.docked as Side) : null;
		return { x: parsed.x, y: parsed.y, docked };
	} catch {
		return null;
	}
}

/** 夹进视口（左上角为基准，右下各留 EDGE） */
function clamp(point: { x: number; y: number }, size: Size, viewport: Viewport): { x: number; y: number } {
	return {
		x: Math.min(Math.max(EDGE, point.x), Math.max(EDGE, viewport.width - size.width - EDGE)),
		y: Math.min(Math.max(EDGE, point.y), Math.max(EDGE, viewport.height - size.height - EDGE)),
	};
}

/** 当前视口（组件里用它，单测里换成假的） */
const viewportOf = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });

/**
 * 松手时的落点：贴到最近的一条边（贴边 = 坐标直接顶到 0 / 视口宽高），
 * 同时给出吸的是哪条边 —— 形状靠这个变半个圆。离边都远就保持原位、不吸。
 *
 * 导出是为了单测：吸附阈值、贴边坐标这些「差几个像素」的事，光看代码很容易写反。
 */
export function settlePlace(point: { x: number; y: number }, size: Size, viewport: Viewport): Place {
	const right = viewport.width - size.width;
	const bottom = viewport.height - size.height;
	const gaps: Record<Side, number> = {
		left: point.x,
		right: right - point.x,
		top: point.y,
		bottom: bottom - point.y,
	};
	let side: Side | null = null;
	let best = SNAP;
	for (const candidate of SIDES) {
		if (gaps[candidate] < best) {
			best = gaps[candidate];
			side = candidate;
		}
	}
	if (side === null) return { ...clamp(point, size, viewport), docked: null };
	return {
		x: side === "left" ? 0 : side === "right" ? right : Math.min(Math.max(EDGE, point.x), Math.max(EDGE, right)),
		y: side === "top" ? 0 : side === "bottom" ? bottom : Math.min(Math.max(EDGE, point.y), Math.max(EDGE, bottom)),
		docked: side,
	};
}

export function SpeechPet() {
	const t = useT();
	const reading = useReading();
	const paused = useSpeechPaused();
	/** 设置里那只开关 + 选的形象（本机偏好，见 speech-pet-prefs） */
	const [petOn] = useStoredBool(PET_ENABLED_KEY, true);
	const [animal] = usePetAnimal();
	const hostRef = useRef<HTMLDivElement | null>(null);
	const [place, setPlace] = useState<Place | null>(readPlace);
	const [dragging, setDragging] = useState(false);
	/** 右键（触屏长按）弹的小菜单：暂停 / 停止 / 设置语音 / 关闭，位置是鼠标（或手指）那一点 */
	const [menuAt, setMenuAt] = useState<MenuPoint | null>(null);
	/** 这一次按下到底算拖还是算点（pointerup 之后的 click 靠它判断，见 `togglePause`） */
	const moved = useRef(false);
	/** 触屏没有右键：**长按 600ms = 停止**（鼠标走 `contextmenu` 那条） */
	const holdTimer = useRef<number | null>(null);
	/** 这一次是长按停掉的：松手后补的那个 click 不该再切暂停 */
	const longPressed = useRef(false);
	const press = useRef<{ pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number } | null>(
		null,
	);

	const sizeOf = () => {
		const rect = hostRef.current?.getBoundingClientRect();
		return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
	};

	/** 视口变了（转屏 / 缩窗口）：夹回来；吸着边的那一侧重新顶到边上 */
	useEffect(() => {
		const reclamp = () =>
			setPlace((current) => {
				if (!current) return current;
				const size = sizeOf();
				const viewport = viewportOf();
				const point = clamp(current, size, viewport);
				return {
					x: current.docked === "left" ? 0 : current.docked === "right" ? viewport.width - size.width : point.x,
					y: current.docked === "top" ? 0 : current.docked === "bottom" ? viewport.height - size.height : point.y,
					docked: current.docked,
				};
			});
		reclamp();
		window.addEventListener("resize", reclamp);
		return () => window.removeEventListener("resize", reclamp);
	}, []);

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		const rect = hostRef.current?.getBoundingClientRect();
		if (!rect) return;
		/**
		 * **先不抢指针**。`setPointerCapture` 一开，`pointerup` 就落到容器上，
		 * `click` 于是派发到「按下与松手的共同祖先」= 容器 —— 猫身上那颗按钮的 onClick 再也不会触发，
		 * 表现就是「点击不能暂停了」（用户 2026-11-24 报的正是这个）。
		 * 所以只在**真的开始拖**（超过 `DRAG_THRESHOLD`）那一刻才抓指针，见 `onPointerMove`。
		 */
		moved.current = false;
		longPressed.current = false;
		// 触屏没有右键：**长按 600ms = 打开同一张菜单**（鼠标走 `onContextMenu`）
		if (event.pointerType !== "mouse") {
			const { clientX, clientY } = event;
			holdTimer.current = window.setTimeout(() => {
				holdTimer.current = null;
				longPressed.current = true;
				setMenuAt({ x: clientX, y: clientY });
			}, 600);
		}
		press.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			offsetX: event.clientX - rect.left,
			offsetY: event.clientY - rect.top,
		};
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const state = press.current;
		if (!state || state.pointerId !== event.pointerId) return;
		if (!moved.current) {
			const far = Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > DRAG_THRESHOLD;
			if (!far) return;
			moved.current = true;
			if (holdTimer.current !== null) {
				clearTimeout(holdTimer.current);
				holdTimer.current = null;
			}
			// 就在这里才抓指针：拖出手势区也不会丢事件（点击 / 长按不受影响）
			event.currentTarget.setPointerCapture(event.pointerId);
			setDragging(true);
			// 一动手就不再是「贴边的半个圆」：先变回整圆，跟着手走
			setPlace((current) => (current?.docked ? { ...current, docked: null } : current));
		}
		const point = clamp(
			{ x: event.clientX - state.offsetX, y: event.clientY - state.offsetY },
			sizeOf(),
			viewportOf(),
		);
		setPlace({ ...point, docked: null });
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		const state = press.current;
		if (!state || state.pointerId !== event.pointerId) return;
		press.current = null;
		setDragging(false);
		if (holdTimer.current !== null) {
			clearTimeout(holdTimer.current);
			holdTimer.current = null;
		}
		if (!moved.current) return; // 只是点了一下：位置不动
		// 用**松手那一刻**的坐标算吸附（state 里的是上一帧，可能还差几像素）
		const landed = settlePlace(
			{ x: event.clientX - state.offsetX, y: event.clientY - state.offsetY },
			sizeOf(),
			viewportOf(),
		);
		setPlace(landed);
		writeStored(POS_KEY, JSON.stringify(landed));
	};

	const togglePause = () => {
		// 刚拖完手一松会补一个 click：那不是「点它」，别顺手改暂停状态
		if (moved.current) {
			moved.current = false;
			return;
		}
		// 长按刚停掉朗读：这次松手补的 click 忽略掉
		if (longPressed.current) {
			longPressed.current = false;
			return;
		}
		if (!reading) return;
		setSpeechPaused(!paused);
	};

	const resetPosition = () => {
		setPlace(null);
		writeStored(POS_KEY, "");
	};

	/**
	 * 三种状态，一只猫全说清楚：
	 *   在念 → 上下轻跳 + 三圈声波往外扩；
	 *   暂停 → **同一只动物**，静止（声波停、也不跳）；
	 *   没在念（点了停止 / 这一轮念完 / 语音没开）→ 同一只动物，慢慢呼吸（`is-idle`），
	 *   一直显示在右下角，像养在那儿一样。
	 * 三种状态都不换表情 —— 换表情会像「把这只换成了另一只」。
	 */
	const state = !reading ? "idle" : paused ? "paused" : "reading";

	// **默认一直养着**（用户 2026-11-24：「宠物默认显示着就行，就像自己养的一样」）：
	// 不再看「语音播报」那个开关 —— 宠物是界面的一部分，不发音的时候它就在那儿待着。
	// 只有显式去 设置 → 语音播报 把「朗读小宠物」关掉，它才不画。
	if (!petOn) return null;

	return (
		<div
			ref={hostRef}
			className={`speech-pet is-${state}${dragging ? " is-dragging" : ""}${
				place?.docked ? ` is-docked-${place.docked}` : ""
			}`}
			/* 没拖过就用 CSS 里的默认位（右下、麦克风上面一格）；拖过之后四边写死，免得和默认位打架 */
			style={place ? { left: `${place.x}px`, top: `${place.y}px`, right: "auto", bottom: "auto" } : undefined}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onDoubleClick={resetPosition}
			/* 右键（触屏长按）= 一张小菜单：停止朗读 / 设置语音功能 / 关闭宠物
			 * （用户 2026-11-24：「点击就可以暂停或是继续，右键可停止、关闭、设置语音功能」）。
			 * 精确、不会误触，也不用在宠物下面挂按钮。 */
			onContextMenu={(event) => {
				event.preventDefault();
				setMenuAt({ x: event.clientX, y: event.clientY });
			}}
			title={t(
				"点：暂停 / 继续 · 右键（触屏长按）：停止 · 拖动：挪位置（贴边吸成半圆）· 双击：回默认位",
				"Click: pause / resume · right-click (long-press): stop · drag to move (snaps to edges) · double-click: reset",
			)}
		>
			<div className="speech-pet-stage">
				{/* 声波：**一圈一圈从宠物身上往外扩**（用户 2026-11-24：「需要是一圈，往外发音的那种效果」）。
				 * 三层同心环错峰发出（每圈都从宠物大小扩到近两倍再淡掉），任何时刻都能看见一圈在半路上，
				 * 读起来就是「声音一直从它这儿冒出来」，而不是某一侧的一条线。 */}
				{state === "reading" ? (
					<span className="speech-pet-ping" aria-hidden="true">
						<i />
						<i />
						<i />
					</span>
				) : null}
				{/* 暂停的小标记：动物右上角一枚小 ⏸ —— 一眼看出「是暂停」而不是「发呆 / 没在念」 */}
				{state === "paused" ? (
					<span className="speech-pet-paused" aria-hidden="true">
						⏸
					</span>
				) : null}
				<button
					type="button"
					className="speech-pet-face"
					onClick={togglePause}
					aria-pressed={paused}
					aria-label={paused ? t("继续朗读", "Resume reading") : t("暂停朗读", "Pause reading")}
					title={
						paused
							? t("点一下接着念（从停下的地方继续）", "Click to resume from where it paused")
							: t("点一下暂停（停在这一句，后面的不会跳过）", "Click to pause here — the rest keeps its place")
					}
				>
					{/* **一直是设置里选的那只动物**：暂停时不是换一张脸（用户 2026-11-24：
					 * 「暂停怎么成这个图片了」——换成 😴 就像把它掉包了）。
					 * 状态改用「有没有声波 + 动不动」说：在念 = 有声波会跳，暂停 = 静态，发呆 = 慢慢呼吸。 */}
					<span aria-hidden="true">{animal}</span>
				</button>
			</div>
			{menuAt ? (
				<ProjectMenuPopover point={menuAt} className="pi-menu" closeOnLeave onClose={() => setMenuAt(null)}>
					<button
						type="button"
						className="proj-menu-item"
						onClick={() => {
							setMenuAt(null);
							setSpeechPaused(!paused);
						}}
					>
						{paused ? `▶ ${t("继续朗读", "Resume reading")}` : `⏸ ${t("暂停朗读", "Pause reading")}`}
					</button>
					<button
						type="button"
						className="proj-menu-item"
						disabled={!reading}
						onClick={() => {
							setMenuAt(null);
							requestStopSpeech();
						}}
					>
						⏹ {t("停止朗读", "Stop reading")}
					</button>
					<button
						type="button"
						className="proj-menu-item"
						onClick={() => {
							setMenuAt(null);
							requestOpenPanel("voice");
						}}
					>
						🔊 {t("设置语音功能", "Voice settings")}
					</button>
					<button
						type="button"
						className="proj-menu-item"
						onClick={() => {
							setMenuAt(null);
							writePetEnabled(false);
						}}
					>
						✕ {t("关闭宠物", "Hide the pet")}
					</button>
				</ProjectMenuPopover>
			) : null}
		</div>
	);
}
