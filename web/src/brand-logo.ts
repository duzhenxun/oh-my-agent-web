/**
 * 自定义 logo（设置 → 外观）：把用户选的图片裁成顶栏能用的那一块。
 *
 * 存哪儿：和顶栏名字一样放**本机**（`brand-name.ts` 里的 `BRAND_LOGO_KEY`，
 * localStorage 里一条 data URL）。理由同上：这只是「这台机器的门面」，换设备就该各是各的，
 * 没必要走一趟服务端；而且图片是二进制，服务端存了还得处理清理 / 配额。
 *
 * 为什么要先在浏览器里缩：localStorage 只有几 MB，而且它是**同步** API ——
 * 把一张 3MB 的手机照片原样塞进去，轻则写失败（QuotaExceeded），重则每次读都卡一下主线程。
 * 顶栏那颗图标最多显示 20px（新会话抬头 38px），所以裁到 192px 就完全够用，
 * 顺手做成正方形（cover 居中）：顶栏 / 抬头两处都是方框，非方图会被拉变形。
 */

/** 存进去的边长：够 38px 抬头在两倍屏上清晰，又不至于撑爆 localStorage */
const LOGO_MAX_PX = 192;

/** 原文件上限：再大就明确拒绝（提示用户自己压一下），而不是默默缩成糊的 */
const LOGO_MAX_BYTES = 8 * 1024 * 1024;

/** 存进去的 data URL 上限（正常情况 20~60KB；超出说明编码没压住，宁可报错也不写坏存储） */
const LOGO_MAX_STORED = 400 * 1024;

function loadImage(file: File): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const image = new Image();
		image.onload = () => {
			URL.revokeObjectURL(url);
			resolve(image);
		};
		image.onerror = () => {
			URL.revokeObjectURL(url);
			// 常见原因：拿扩展名骗人的文件、SVG 里带了外部引用、HEIC（Safari 之外解不了）
			reject(new Error("这张图片打不开，换一张 PNG / JPG / WebP 试试"));
		};
		image.src = url;
	});
}

/**
 * 读一个用户选的文件 → 可以存进 localStorage 的 data URL。
 *
 * 失败一律 `throw new Error(<给人看的中文说明>)`：调用方直接 `showToast(err.message)`，
 * 不用在这里决定怎么提示（这里连 toast 都不该 import）。
 */
export async function readLogoFile(file: File): Promise<string> {
	if (!file.type.startsWith("image/")) throw new Error("这不是图片文件");
	if (file.size > LOGO_MAX_BYTES) throw new Error("图片太大了（请选 8MB 以内的）");
	const image = await loadImage(file);
	const side = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
	if (!side) throw new Error("这张图片打不开，换一张 PNG / JPG / WebP 试试");

	const canvas = document.createElement("canvas");
	canvas.width = LOGO_MAX_PX;
	canvas.height = LOGO_MAX_PX;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("这个浏览器画不了图（canvas 不可用）");
	// 从原图正中取一块正方形（cover），再缩到 LOGO_MAX_PX
	const sx = ((image.naturalWidth || image.width) - side) / 2;
	const sy = ((image.naturalHeight || image.height) - side) / 2;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(image, sx, sy, side, side, 0, 0, LOGO_MAX_PX, LOGO_MAX_PX);

	// WebP 优先（同画质体积约是 PNG 的 1/3）；浏览器不认就自动回落到 PNG
	const webp = canvas.toDataURL("image/webp", 0.92);
	const dataUrl = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
	if (dataUrl.length > LOGO_MAX_STORED) throw new Error("这张图压缩后还是太大，换一张简单点的图试试");
	return dataUrl;
}
