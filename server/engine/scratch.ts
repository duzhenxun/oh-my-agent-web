/**
 * 「一次性会话」判定：临时目录里跑出来的会话不进侧栏（codex / dsh 共用）。
 *
 * 两个引擎都会在 `/tmp` 里留下大量 `codex exec` / 测试跑出来的会话，
 * 把它们塞进侧栏只是噪音。判据放在一处，两个引擎的过滤规则保持一致。
 */
import { tmpdir } from "node:os";

export function isScratchCwd(cwd: string): boolean {
	if (cwd === "") return true;
	const scratch = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
	return scratch.some((prefix) => cwd === prefix || cwd.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}
