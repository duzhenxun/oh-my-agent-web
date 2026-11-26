/**
 * 「提 Bug」：把现场信息拼成一条能直接提交的 GitHub issue。
 *
 * 为什么要有这个文件（而不是在面板里现拼字符串）：脱敏、长度上限、URL 编码这三件事
 * 全是**容易悄悄出错、又只能靠人肉回看**的活 —— 抽成纯函数才测得了。
 * 面板（`components/BugPanel.tsx`）只管收字和开链接，正文一律从这儿出。
 *
 * 提交到哪：仓库自己的 `/issues/new`（`REPO_URL`，见 `brand.ts`）。
 * issue 是**公开**的，所以正文里不能出现家目录、token 这类东西 —— 见 `redact()`。
 */
import { REPO_URL } from "./brand.ts";

/** 面板收集到的现场（全部来自快照，用户不用自己抄） */
export type BugReport = {
	/** 一句话：什么坏了（= issue 标题） */
	summary: string;
	/** 补充描述 / 复现步骤（用户自己写，可以空） */
	detail: string;
	/** 产品版本（`snapshot.versions.web`） */
	version: string | null;
	engine: string | null;
	engineVersion: string | null;
	model: string | null;
	sessionId: string | null;
	/** 平台串（已脱敏，见 `redact`） */
	platform: string;
};

/**
 * 标题长度上限。
 *
 * GitHub 自己接受 256，但顶栏 / 手机通知里都只显示前几十个字 —— 超过 80 的部分
 * 对「一眼看出是什么问题」没有帮助，反而会把 issue 列表挤成一坨。截断而不是拒绝：
 * 用户写长句是常事，不该为此弹一个报错。
 */
export const BUG_TITLE_MAX = 80;

/**
 * 正文长度上限。
 *
 * 这条不是给 GitHub 的，是给 **URL** 的：整份正文要塞进 `?body=`，浏览器与
 * 某些代理对 URL 长度并不友好（Safari 约 8k 就截）。4000 个字符编码后约 9k，
 * 仍在安全区；超出的部分宁愿截断 —— 反正真正的现场在诊断区，用户描述没了还能补。
 */
export const BUG_BODY_MAX = 4000;

/**
 * 脱敏：把**家目录**换成 `~`、把常见 token 打码。
 *
 * 为什么家目录要换掉：诊断里会带工作区 / 路径，`/Users/<真名>/…` 写进公开 issue
 * 等于把用户名贴出去。token 同理 —— 用户手滑粘进来的 key 不能因为我们「顺手带上现场」而泄露。
 */
export function redact(text: string): string {
	return (
		text
			// macOS / Linux：/Users/dszx/a、/home/me/a → ~/a
			.replace(/\/(?:Users|home)\/[^/\s"'`]+/g, "~")
			// Windows：C:\Users\dszx\a → ~\a
			.replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "~")
			// 常见密钥前缀：宁可多打一次码，也别赌它是不是真的 key
			.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "***")
			.replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}/g, "***")
			.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "***")
			.replace(/\bAKIA[0-9A-Z]{12,}/g, "***")
	);
}

/** 标题：压成一行、脱敏、超长截断；用户什么都没写就返回空串（面板据此禁用按钮） */
export function bugIssueTitle(report: Pick<BugReport, "summary">): string {
	const single = redact(report.summary).replace(/\s+/g, " ").trim();
	if (!single) return "";
	return single.length > BUG_TITLE_MAX ? `${single.slice(0, BUG_TITLE_MAX - 1)}…` : single;
}

/** 环境那一小段（正文与「复制报告」共用：两处写法必须一模一样，否则填 bug 的人对不上号） */
function environmentLines(report: BugReport): string[] {
	const version = report.version?.trim() || "未知";
	const engine = report.engine?.trim() || "未知";
	const engineVersion = report.engineVersion?.trim();
	const model = report.model?.trim() || "未选";
	return [
		`- 版本：${version}`,
		`- 引擎：${engine}${engineVersion ? ` ${engineVersion}` : ""}`,
		`- 模型：${model}`,
		`- 会话：${report.sessionId?.trim() || "（新会话）"}`,
		`- 平台：${redact(report.platform).trim() || "未知"}`,
	];
}

/**
 * issue 正文（Markdown）。
 *
 * 结构固定成「发生了什么 / 环境 / 还看到什么」三段：填过 bug 的人知道，缺环境信息时
 * 只能来回问三轮 —— 所以环境自动带上，用户只需要写第一段。
 */
export function bugIssueBody(report: BugReport): string {
	const detail = redact(report.detail).trim();
	const head = [
		"## 发生了什么",
		"",
		detail || "_（可以补充：期望看到什么、实际看到什么、复现步骤）_",
		"",
		"## 环境",
		"",
		...environmentLines(report),
		"",
		"---",
		"",
		"_由 oh-my-agent-web 的「提 Bug」面板自动填写；里面有我不希望公开的内容，可以直接删掉。_",
	].join("\n");
	return head.length > BUG_BODY_MAX ? `${head.slice(0, BUG_BODY_MAX - 12)}\n\n…（已截断）` : head;
}

/** 复制到剪贴板的那份：跟 issue 正文一字不差，方便直接粘到群里 / 邮件里 */
export function bugReportText(report: BugReport): string {
	const title = bugIssueTitle(report) || "（未填写标题）";
	return `${title}\n\n${bugIssueBody(report)}`;
}

/**
 * GitHub 新建 issue 的链接：标题 + 正文 + `bug` 标签都预填好。
 *
 * 用 `URLSearchParams` 而不是手拼 —— 正文里有 `#`、`&`、换行，手拼必然漏一处。
 * 编码后的空格是 `+`，GitHub 认这个（浏览器地址栏里也照常显示成空格）。
 */
export function bugIssueUrl(report: BugReport): string {
	const params = new URLSearchParams();
	params.set("title", bugIssueTitle(report) || "（没写标题）");
	params.set("body", bugIssueBody(report));
	params.set("labels", "bug");
	return `${REPO_URL}/issues/new?${params.toString()}`;
}
