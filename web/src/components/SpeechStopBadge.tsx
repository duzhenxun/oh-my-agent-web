/**
 * 朗读中的浮条：暂停 / 继续 + 停止，**可以拖到页面上任意位置**。
 *
 * 以前它固定贴在底部居中（`bottom: 78px; left: 50%`），正好压住输入框和状态栏 ——
 * 用户 2026-11-21 明确要求「能移动」。所以：
 *   - 按住浮条任意空白处（或左边那把握把）就能拖，松手位置记在 localStorage；
 *   - 默认停在**右侧中部**（不再压输入框），双击握把回到默认位；
 *   - **竖排**（用户 2026-11-21：「还是横着的，改成竖着布局」）：横条在窄屏上会横跨半个屏幕，
 *     竖排只占一列，按钮等宽，「暂停 / 停止」上下叠着点更准；
 *   - 位置始终被夹在视口里：窗口缩小 / 手机转屏不会把它甩到看不见的地方。
 *
 * 暂停语义见 `speech-control.ts` / `tts.ts`：冻住当前这句，不停掉这一轮。
 */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { readStored, writeStored } from "../ui-prefs.ts";
import { requestStopSpeech, setSpeechPaused, useReading, useSpeechPaused } from "../speech-control.ts";
import { formatCombo, isMacPlatform } from "../shortcuts.ts";
import { useShortcuts } from "../use-shortcuts.ts";
import { useT } from "../use-language.ts";

type Point = { x: number; y: number };

/**
 * 磨砂玻璃的模糊。
 *
 * 为什么写在行内样式里而不是 CSS 类里：构建时的 CSS 压缩会把 `backdrop-filter` 与
 * `-webkit-backdrop-filter` 合并成只剩前缀那一条，而 Chrome 只认标准写法 ——
 * 结果就是「CSS 里明明有，页面上却没有模糊」。行内样式不经过压缩器，两种写法都能落地。
 */
const GLASS: CSSProperties = {
	backdropFilter: "blur(14px) saturate(1.35)",
	WebkitBackdropFilter: "blur(14px) saturate(1.35)",
};

/**
 * 拖动位置的键。
 *
 * 带 `v2`：默认位从「右侧垂直居中」改成「右下角」之后，旧位置（记住的那条 `agent-web.speech.badge.pos`）
 * 会把浮条又拽回正文上面 —— 用户 2026-11-21：「默认位置压在这个对话里面了」。
 * 换键 = 老位置作废，一次性地回到新默认位；之后拖动照旧记忆。
 */
const POS_KEY = "agent-web.speech.badge.pos.v2";
/** 至少留这么多像素在视口内，保证「拖出屏幕」之后还抓得回来 */
const EDGE = 8;

function clampPoint(point: Point, size: { width: number; height: number }): Point {
	const maxX = Math.max(EDGE, window.innerWidth - size.width - EDGE);
	const maxY = Math.max(EDGE, window.innerHeight - size.height - EDGE);
	return {
		x: Math.min(Math.max(EDGE, point.x), maxX),
		y: Math.min(Math.max(EDGE, point.y), maxY),
	};
}

/** 读上次拖到的位置；坏数据（手改过 localStorage / 旧格式）一律当没存过 */
function readStoredPoint(): Point | null {
	const raw = readStored(POS_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<Point>;
		if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
		if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
		return { x: parsed.x, y: parsed.y };
	} catch {
		return null;
	}
}

export function SpeechStopBadge({
	/**
	 * `docked`：钉在输入框顶栏里的**横排常驻**控件（用户 2026-11-21：不要悬浮、
	 * 放到快捷短语那一排的后面、固定位置、一直显示）。没在朗读时置灰不可点。
	 */
	docked = false,
}: { docked?: boolean } = {}) {
	const t = useT();
	const reading = useReading();
	const paused = useSpeechPaused();
	const [shortcuts] = useShortcuts();
	const hostRef = useRef<HTMLDivElement | null>(null);
	// docked 形态：没有拖动，也没有位置记忆
	const clickable = reading;
	const [pos, setPos] = useState<Point | null>(readStoredPoint);
	const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
	const [dragging, setDragging] = useState(false);

	// 挂出来时先夹一次：上次在大窗口里拖到的位置，换设备 / 转屏后可能已经在屏幕外
	useEffect(() => {
		if (!reading) return;
		const box = hostRef.current?.getBoundingClientRect();
		if (!box) return;
		setPos((current) => {
			if (!current) return current;
			const next = clampPoint(current, { width: box.width, height: box.height });
			return next.x === current.x && next.y === current.y ? current : next;
		});
	}, [reading]);

	// 视口变了（转屏 / 缩窗口）也再夹一次
	useEffect(() => {
		if (!reading) return;
		const onResize = () => {
			const box = hostRef.current?.getBoundingClientRect();
			if (!box) return;
			setPos((current) => {
				if (!current) return current;
				const next = clampPoint(current, { width: box.width, height: box.height });
				return next.x === current.x && next.y === current.y ? current : next;
			});
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [reading]);

	// docked 形态要**一直显示**（没在朗读时置灰），所以这个提前返回只对悬浮款生效
	if (!reading && !docked) return null;
	// 快捷键**不显示了**（用户 2026-11-21：「这个不用显示快捷键」）：那颗 kbd 占宽度、
	// 又和两个按钮抢注意力。停止键只在 tooltip 里留一条，暂停键同理（见下）。
	const stopCombo = formatCombo(shortcuts.stopSpeech ?? null, isMacPlatform());
	const pauseCombo = formatCombo(shortcuts.pauseSpeech ?? null, isMacPlatform());
	const size = () => {
		const box = hostRef.current?.getBoundingClientRect();
		return { width: box?.width ?? 0, height: box?.height ?? 0 };
	};

	/** 拖动起点：从按钮上按下不算拖动，否则「暂停 / 停止」会被拖拽吞掉 */
	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		if ((event.target as HTMLElement).closest("button")) return;
		const box = hostRef.current?.getBoundingClientRect();
		if (!box) return;
		// 先占住指针：拖出手指/鼠标跑得再快也不会丢事件（触屏尤其明显）
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = {
			pointerId: event.pointerId,
			offsetX: event.clientX - box.left,
			offsetY: event.clientY - box.top,
		};
		setDragging(true);
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const state = drag.current;
		if (!state || state.pointerId !== event.pointerId) return;
		setPos(
			clampPoint(
				{ x: event.clientX - state.offsetX, y: event.clientY - state.offsetY },
				size(),
			),
		);
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		const state = drag.current;
		if (!state || state.pointerId !== event.pointerId) return;
		drag.current = null;
		setDragging(false);
		const box = hostRef.current?.getBoundingClientRect();
		// 存「真正落下的位置」而不是 state：这一拍 state 可能还没渲染进去
		if (box) writeStored(POS_KEY, JSON.stringify({ x: Math.round(box.left), y: Math.round(box.top) }));
	};

	const resetPosition = () => {
		setPos(null);
		writeStored(POS_KEY, "");
	};

	if (docked) {
		return (
			<div
				className={`speech-dock${reading ? " is-reading" : ""}${paused ? " is-paused" : ""}`}
				title={
					reading
						? paused
							? t("朗读已暂停（点「继续」接着念）", "Reading paused — click Resume")
							: t("正在朗读（你说话时会自动暂停）", "Reading aloud (pauses while you speak)")
						: t("还没有在朗读：回复会自动念出来", "Nothing is being read yet")
				}
			>
				<span className="speech-dock-icon" aria-hidden="true">
					{reading ? (paused ? "⏸" : "🔊") : "🔇"}
				</span>
				<button
					type="button"
					className="speech-dock-btn"
					disabled={!clickable}
					onClick={() => setSpeechPaused(!paused)}
					title={(paused ? t("接着念", "Resume") : t("暂停一下", "Pause")) + (pauseCombo ? ` · ${pauseCombo}` : "")}
				>
					{paused ? t("继续", "Resume") : t("暂停", "Pause")}
				</button>
				<button
					type="button"
					className="speech-dock-btn speech-dock-stop"
					disabled={!clickable}
					onClick={requestStopSpeech}
					title={t("停掉朗读（这一轮剩下的也不再念）", "Stop reading this turn") + (stopCombo ? ` · ${stopCombo}` : "")}
				>
					{t("停止", "Stop")}
				</button>
			</div>
		);
	}

	return (
		<div
			ref={hostRef}
			className={`speech-badge${dragging ? " is-dragging" : ""}${paused ? " is-paused" : ""}`}
			/* 没拖过就是默认位（CSS 里的右侧中部）；拖过之后用绝对坐标，四边都写死免得互相打架 */
			style={
				pos
					? { ...GLASS, left: `${pos.x}px`, top: `${pos.y}px`, right: "auto", bottom: "auto", transform: "none" }
					: GLASS
			}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			/* 去掉了 ⠿ 握把（用户 2026-11-21「把 ⠿ 也去掉再窄一点」）：
			   复位改成**双击这条浮条的空白处**，点按钮不会误触发 */
			onDoubleClick={(event) => {
				if ((event.target as HTMLElement).closest("button")) return;
				resetPosition();
			}}
			title={t("按住拖动到任意位置（双击空白处回到默认位置）", "Drag anywhere (double-click the empty area to reset)")}
		>
			{/* 只留图标，不写「朗读 / 暂停」两个字：用户 2026-11-21「朗读两个字可以不要」 */}
			<span className="speech-badge-head" aria-hidden="true">
				{paused ? "⏸" : "🔊"}
			</span>
			<button
				type="button"
				className="speech-badge-btn"
				onClick={() => setSpeechPaused(!paused)}
				title={
					(paused
						? t("接着念（从刚才停下的地方继续）", "Resume from where it paused")
						: t("暂停一下（停在这一句，不会跳过后面的）", "Pause here (the rest keeps its place)")) +
					(pauseCombo ? ` · ${pauseCombo}` : "")
				}
			>
				{paused ? t("继续", "Resume") : t("暂停", "Pause")}
			</button>
			<button
				type="button"
				className="speech-badge-btn speech-badge-stop"
				onClick={requestStopSpeech}
				title={t("停掉朗读（这一轮剩下的文字也不再自动念）", "Stop reading (the rest of this turn stays silent)") + (stopCombo ? ` · ${stopCombo}` : "")}
			>
				{t("停止", "Stop")}
			</button>
		</div>
	);
}
