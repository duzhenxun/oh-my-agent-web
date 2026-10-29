/**
 * pi SDK 的版本号（界面抬头显示 `pi v1.3.0`）。
 *
 * 用 SDK 自己导出的 `VERSION`，不去读它的 package.json：那个包只导出 `import`/`.`，
 * `require.resolve("…/package.json")` 会报 ERR_PACKAGE_PATH_NOT_EXPORTED。
 * 单独一个文件是为了守住 ADR-0003（只有 server/engine 能碰 SDK）与 400 行护栏。
 */
import { VERSION } from "@earendil-works/pi-coding-agent";

export function piSdkVersion(): string | null {
	return typeof VERSION === "string" && VERSION.trim() !== "" ? VERSION.trim() : null;
}
