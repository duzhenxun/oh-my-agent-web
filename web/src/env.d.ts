/**
 * 前端全局类型补充。
 * 注意：这里刻意不引 `vite/client`（vite 尚未安装），
 * 只声明本项目真正用到的资源模块类型。
 */

declare module "*.css";
declare module "*.svg" {
	const src: string;
	export default src;
}
/** 预生成的状态语音片段，按 `?url` 当静态资源引入（见 assets/cues 与 scripts/make-voice-cues.mjs） */
declare module "*.mp3?url" {
	const src: string;
	export default src;
}
