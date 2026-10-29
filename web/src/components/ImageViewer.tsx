/**
 * 图片预览浮层（挂在 App 里一次，`image-viewer.ts` 的 openImageViewer 就能从任何地方弹）。
 *
 * 交互刻意做得很薄：**Esc / 点空白 / 关闭按钮** 都是关；底部工具条给「缩小 / 放大 / 重置 / 下载」。
 * 缩放是相对「适应窗口」的档位（100% = 刚好放进视口），放大后图超出视口就在这一层里滚动查看，
 * 不牵动底下的对话（打开期间页面滚动被锁住）。
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import {
	closeImageViewer,
	downloadNameOf,
	fitScaleOf,
	useViewedImage,
	zoomBy,
	ZOOM_MAX,
	ZOOM_MIN,
} from "../image-viewer.ts";
import { useT } from "../use-language.ts";

type Natural = { width: number; height: number };

export function ImageViewer() {
	const image = useViewedImage();
	const t = useT();
	const open = image !== null;

	const [scale, setScale] = useState(1);
	const [natural, setNatural] = useState<Natural | null>(null);
	const [fit, setFit] = useState(1);
	const [downloading, setDownloading] = useState(false);

	const src = image?.src ?? "";

	// 换一张图就回到「适应窗口」，不要继承上一张的缩放
	useEffect(() => {
		setScale(1);
		setNatural(null);
		setFit(1);
		setDownloading(false);
	}, [src]);

	// Esc 关闭 / +− 缩放 / 0 重置；打开期间锁住页面滚动（否则滚轮会滚到底下的对话）
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				closeImageViewer();
				return;
			}
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (event.key === "+" || event.key === "=") setScale((value) => zoomBy(value, "in"));
			else if (event.key === "-" || event.key === "_") setScale((value) => zoomBy(value, "out"));
			else if (event.key === "0") setScale(1);
		};
		window.addEventListener("keydown", onKeyDown);
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previous;
		};
	}, [open]);

	/** 图加载完才知道原始尺寸：据此算「适应窗口」的比例，后面放大都以它为基准 */
	const onLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
		const element = event.currentTarget;
		const width = element.naturalWidth;
		const height = element.naturalHeight;
		if (width <= 0 || height <= 0) return;
		setNatural({ width, height });
		setFit(fitScaleOf({ width, height }, { width: window.innerWidth, height: window.innerHeight }));
	}, []);

	/** 下载：同源走 blob（保留原始文件名），跨域拿不到就退回「新标签页看原图」 */
	const download = useCallback(async () => {
		if (!src || downloading) return;
		const name = downloadNameOf(src, image?.alt ?? "");
		setDownloading(true);
		try {
			const response = await fetch(src, { credentials: "same-origin" });
			if (!response.ok) throw new Error(String(response.status));
			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = name;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			// 立刻 revoke 会让下载中途断掉，留几秒
			window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} catch {
			window.open(src, "_blank", "noopener,noreferrer");
		} finally {
			setDownloading(false);
		}
	}, [downloading, image?.alt, src]);

	if (!image) return null;

	// 缩放后按「适应窗口的像素尺寸 × 档位」给出真实宽高：
	// 用 transform 缩放不会改变布局尺寸，滚动条就出不来，放大后看不到图的其余部分。
	const zoomed = scale !== 1 && natural !== null;
	const style = zoomed
		? { width: Math.round(natural.width * fit * scale), height: "auto" as const, maxWidth: "none", maxHeight: "none" }
		: undefined;

	const percent = Math.round(fit * scale * 100);

	return createPortal(
		<div
			className="image-viewer-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label={t("图片预览", "Image preview")}
			// 点空白关闭；工具条和图片自己处理点击，不会冒到这里来关（图片见 stage 的 target 判断）
			onClick={() => closeImageViewer()}
		>
			<button
				type="button"
				className="image-viewer-close"
				title={t("关闭（Esc）", "Close (Esc)")}
				aria-label={t("关闭", "Close")}
				onClick={() => closeImageViewer()}
			>
				×
			</button>
			<div
				className="image-viewer-stage"
				// 只有点在「图以外的空白」上才关：放大后拖动、看图时误触都不该把浮层关掉
				onClick={(event) => {
					if (event.target === event.currentTarget) closeImageViewer();
				}}
			>
				<img className="image-viewer-img" src={src} alt={image.alt} style={style} onLoad={onLoad} />
			</div>
			<div className="image-viewer-tools" onClick={(event) => event.stopPropagation()}>
				<button
					type="button"
					className="image-viewer-tool"
					title={t("缩小（-）", "Zoom out (-)")}
					aria-label={t("缩小", "Zoom out")}
					disabled={scale <= ZOOM_MIN}
					onClick={() => setScale((value) => zoomBy(value, "out"))}
				>
					−
				</button>
				<button
					type="button"
					className="image-viewer-zoom"
					title={t("点一下回到适应窗口（0）", "Click to reset to fit (0)")}
					onClick={() => setScale(1)}
				>
					{percent}%
				</button>
				<button
					type="button"
					className="image-viewer-tool"
					title={t("放大（+）", "Zoom in (+)")}
					aria-label={t("放大", "Zoom in")}
					disabled={scale >= ZOOM_MAX}
					onClick={() => setScale((value) => zoomBy(value, "in"))}
				>
					+
				</button>
				<span className="image-viewer-divider" aria-hidden="true" />
				<button
					type="button"
					className="image-viewer-tool image-viewer-download"
					title={t("下载这张图", "Download this image")}
					disabled={downloading}
					onClick={() => void download()}
				>
					{t("下载", "Download")}
				</button>
			</div>
		</div>,
		document.body,
	);
}
