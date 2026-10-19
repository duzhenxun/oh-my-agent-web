/**
 * 「这条命令是不是只读」（ADR-0006 的补充）：不要把读操作也丢给用户确认。
 *
 * 真事：`sed -n 425,470p file` + `grep` 这种纯查看也会弹窗，用户被迫点几十次「允许一次」，
 * 最后养成"闭眼允许"的习惯 —— 那比不问更危险。
 *
 * 判定偏保守（宁可多问一次，不要漏放一次写操作）：
 *   1. 命令里的每个可执行名都必须在白名单里；
 *   2. 不能有 `>`、`>>`、`tee`、`&>` 这类写文件的重定向（`2>&1` 除外）；
 *   3. `sed`/`perl` 带 `-i`（原地改写）一律不算只读；
 *   4. 不能有 `$(...)`、反引号、`rm/mv/cp/chmod/...` 这类明显的写操作。
 */

/** 只读可执行名（能看、能过滤、能统计，但不落盘） */
const READ_ONLY_BINARIES = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"grep",
	"egrep",
	"rg",
	"ag",
	"find",
	"fd",
	"sed",
	"awk",
	"cut",
	"sort",
	"uniq",
	"tr",
	"echo",
	"printf",
	"pwd",
	"whoami",
	"date",
	"which",
	"type",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	"jq",
	"basename",
	"dirname",
	"realpath",
	"md5sum",
	"shasum",
	"sha256sum",
	"diff",
	"comm",
	"column",
	"nl",
	"rev",
	"seq",
	"expr",
	"test",
	"true",
	"false",
]);

/** 一旦出现这些词，直接判定「不是只读」 */
const WRITE_HINTS =
	/\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|install|dd|mkfs|truncate|tee|git|npm|pnpm|yarn|pip|brew|docker|kubectl|curl|wget|ssh|scp)\b/;

/** 把一个 shell 片段按 `&&`、`||`、`;`、`|`、换行拆开（不处理引号里的分隔符 —— 保守起见够了） */
function splitCommands(command: string): string[] {
	return command
		.split(/\n|&&|\|\||;|\|/)
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

/** 取一段命令的可执行名（跳过 `FOO=1 cmd` 这种前置赋值与 sudo/env 之类） */
function executableOf(part: string): string | null {
	const tokens = part.split(/\s+/).filter((token) => token !== "");
	let index = 0;
	// 跳过环境变量赋值
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
	const name = tokens[index];
	if (!name) return null;
	return name.split("/").pop() ?? name;
}

export function isReadOnlyCommand(command: string): boolean {
	const text = command.trim();
	if (text === "") return false;
	// 命令替换、反引号：内容不可预知 → 不算只读
	if (text.includes("$(") || text.includes("`")) return false;
	if (WRITE_HINTS.test(text)) return false;
	// 写文件的重定向（`2>&1`、`2> /dev/null` 这类放行）
	if (/(^|[^0-9])>>?/.test(text.replace(/[0-9]?>&[0-9]/g, "").replace(/2>\s*\/dev\/null/g, ""))) return false;
	// sed -i / perl -i 原地改写
	if (/\bsed\b[^|;]*\s-i/.test(text) || /\bperl\b[^|;]*\s-i/.test(text)) return false;
	// 逐个片段检查可执行名
	for (const part of splitCommands(text)) {
		const name = executableOf(part);
		if (name === null) return false;
		if (!READ_ONLY_BINARIES.has(name)) return false;
	}
	return true;
}
