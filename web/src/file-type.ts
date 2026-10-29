/**
 * 文件树前面的「类型小标」（GO / {} / PY / SH …）。
 *
 * 为什么不用 emoji 或彩色图标包：一屏几十个文件，emoji 大小不齐会乱；图标包又要多几百 KB。
 * 这里只用「两三个字母的短标签 + 一个主题色」，信息密度高、颜色还能跟着主题走。
 *
 * 纯函数：文件名 → `{ label, tone }`；认不出的类型给 `null`（界面退回一个通用文档图标）。
 */

/** 颜色分组：值都在 CSS 里（`.filetype-go` 这种类），这里只给语义 */
type FileTone =
	"go" | "ts" | "js" | "json" | "py" | "sh" | "md" | "style" | "markup" | "data" | "sql" | "rs" | "jvm" | "c" | "text";

type FileTypeBadge = { label: string; tone: FileTone };

const BY_EXTENSION: Record<string, FileTypeBadge> = {
	go: { label: "GO", tone: "go" },
	ts: { label: "TS", tone: "ts" },
	tsx: { label: "TS", tone: "ts" },
	mts: { label: "TS", tone: "ts" },
	cts: { label: "TS", tone: "ts" },
	js: { label: "JS", tone: "js" },
	jsx: { label: "JS", tone: "js" },
	mjs: { label: "JS", tone: "js" },
	cjs: { label: "JS", tone: "js" },
	vue: { label: "VUE", tone: "js" },
	svelte: { label: "SV", tone: "js" },
	json: { label: "{}", tone: "json" },
	jsonc: { label: "{}", tone: "json" },
	json5: { label: "{}", tone: "json" },
	py: { label: "PY", tone: "py" },
	pyi: { label: "PY", tone: "py" },
	sh: { label: "SH", tone: "sh" },
	bash: { label: "SH", tone: "sh" },
	zsh: { label: "SH", tone: "sh" },
	fish: { label: "SH", tone: "sh" },
	ps1: { label: "PS", tone: "sh" },
	md: { label: "MD", tone: "md" },
	markdown: { label: "MD", tone: "md" },
	mdx: { label: "MD", tone: "md" },
	css: { label: "CSS", tone: "style" },
	scss: { label: "CSS", tone: "style" },
	sass: { label: "CSS", tone: "style" },
	less: { label: "CSS", tone: "style" },
	html: { label: "<>", tone: "markup" },
	htm: { label: "<>", tone: "markup" },
	xml: { label: "<>", tone: "markup" },
	svg: { label: "<>", tone: "markup" },
	yaml: { label: "YML", tone: "data" },
	yml: { label: "YML", tone: "data" },
	toml: { label: "TOML", tone: "data" },
	ini: { label: "INI", tone: "data" },
	env: { label: "ENV", tone: "data" },
	conf: { label: "CFG", tone: "data" },
	csv: { label: "CSV", tone: "data" },
	sql: { label: "SQL", tone: "sql" },
	rs: { label: "RS", tone: "rs" },
	java: { label: "JAVA", tone: "jvm" },
	kt: { label: "KT", tone: "jvm" },
	kts: { label: "KT", tone: "jvm" },
	gradle: { label: "GRD", tone: "jvm" },
	c: { label: "C", tone: "c" },
	h: { label: "C", tone: "c" },
	cc: { label: "C++", tone: "c" },
	cpp: { label: "C++", tone: "c" },
	hpp: { label: "C++", tone: "c" },
	cs: { label: "C#", tone: "c" },
	txt: { label: "TXT", tone: "text" },
	log: { label: "LOG", tone: "text" },
	lock: { label: "LOCK", tone: "text" },
};

/** 按「文件名优先、扩展名兜底」认类型：Dockerfile / Makefile 这类没有扩展名 */
export function fileTypeOf(name: string): FileTypeBadge | null {
	const lower = name.toLowerCase();
	if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return { label: "DOCK", tone: "sh" };
	if (lower === "makefile" || lower === "gnumakefile") return { label: "MK", tone: "sh" };
	if (lower === ".gitignore" || lower === ".gitattributes") return { label: "GIT", tone: "text" };
	if (lower === "go.mod" || lower === "go.sum") return { label: "GO", tone: "go" };
	if (lower === "package.json" || lower === "tsconfig.json") return { label: "{}", tone: "json" };
	const dot = lower.lastIndexOf(".");
	if (dot < 0) return null;
	return BY_EXTENSION[lower.slice(dot + 1)] ?? null;
}
