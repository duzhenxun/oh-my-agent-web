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
