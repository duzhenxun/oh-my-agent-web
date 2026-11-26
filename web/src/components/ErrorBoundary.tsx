import { Component, type ErrorInfo, type ReactNode } from "react";
import { useT } from "../use-language.ts";

/**
 * 界面级错误边界：**白屏的最后一道防线**。
 *
 * 为什么必须有：React 里只要 render / 生命周期里抛一次没人接的错，整棵树就会被卸载，
 * 用户看到的就是一片白（窗口还在、标题栏还在，但什么都没有）。用户 2026-11-26 就撞上了这种：
 * 「操作弹窗时白屏了」，而且现场什么都没留下 —— 没有日志、没有错误信息，只能靠猜。
 *
 * 这里做三件事：
 *   1. 把错误**画在屏幕上**（message + 堆栈 + 组件栈），一眼能看出来是哪块炸的；
 *   2. 存一份到 localStorage（`agent-web.last-crash`）：重载之后还在，能贴给 agent / 提 issue；
 *   3. 给「重新加载」和「复制错误详情」两个出口 —— 白屏时至少还有路可走。
 *
 * 边界包在 `<App />` 外面（见 main.tsx），所以它自己不能依赖 App 里的任何状态
 * （store / ws 都还没就绪）；样式走 error-boundary.css 里的独立类名。
 */

const CRASH_KEY = "agent-web.last-crash";

type CrashInfo = {
	/** 给用户看的简短说明 */
	message: string;
	/** 完整堆栈（React 的组件栈也拼在里面） */
	detail: string;
	at: number;
};

function readLastCrash(): CrashInfo | null {
	try {
		const raw = localStorage.getItem(CRASH_KEY);
		if (raw === null) return null;
		const value = JSON.parse(raw) as unknown;
		if (typeof value !== "object" || value === null) return null;
		const record = value as Partial<CrashInfo>;
		if (typeof record.message !== "string") return null;
		return { message: record.message, detail: typeof record.detail === "string" ? record.detail : "", at: record.at ?? 0 };
	} catch {
		return null;
	}
}

function saveLastCrash(info: CrashInfo): void {
	try {
		localStorage.setItem(CRASH_KEY, JSON.stringify(info));
	} catch {
		// 存不进去只影响「重载后还能看到现场」，不该再抛一次错
	}
}

/** 把 Error 压成「第一行 = 说明，下面 = 堆栈」的一段文本 */
function describe(error: unknown, info: ErrorInfo): CrashInfo {
	const err = error instanceof Error ? error : new Error(String(error));
	const stack = [err.stack ?? `${err.name}: ${err.message}`, info.componentStack ?? ""]
		.filter((part) => part.trim() !== "")
		.join("\n\n组件栈：\n");
	return { message: err.message || err.name || "未知错误", detail: stack, at: Date.now() };
}

type Props = { children: ReactNode };
type State = { crash: CrashInfo | null; copied: boolean };

export class ErrorBoundary extends Component<Props, State> {
	state: State = { crash: null, copied: false };

	static getDerivedStateFromError(error: unknown): State {
		// 这里拿不到 componentStack（React 只把它给 componentDidCatch），先存个粗的
		const err = error instanceof Error ? error : new Error(String(error));
		return { crash: { message: err.message || err.name || "未知错误", detail: err.stack ?? "", at: Date.now() }, copied: false };
	}

	componentDidCatch(error: unknown, info: ErrorInfo): void {
		const crash = describe(error, info);
		// 控制台留一份（DevTools 里能看到完整对象），localStorage 留一份（重载后还在）
		console.error("[oh-my-agent-web] 界面崩溃：", error, info.componentStack);
		saveLastCrash(crash);
		this.setState({ crash });
	}

	render(): ReactNode {
		if (this.state.crash !== null) {
			return <CrashScreen crash={this.state.crash} copied={this.state.copied} onCopied={() => this.setState({ copied: true })} />;
		}
		return this.props.children;
	}
}

/** 白屏时的那一屏：说明 + 堆栈 + 两个出口 */
function CrashScreen({ crash, copied, onCopied }: { crash: CrashInfo; copied: boolean; onCopied: () => void }) {
	// 这里不能用 App 的 t()：语言表可能在崩溃的这条路径里也没加载好（useT 自己能兜住，所以照用）
	const t = useT();
	const copy = () => {
		const text = `界面崩溃：${crash.message}\n时间：${new Date(crash.at).toLocaleString()}\n\n${crash.detail}`;
		void navigator.clipboard?.writeText(text).then(onCopied, () => undefined);
	};
	return (
		<div className="crash-screen">
			<div className="crash-card">
				<div className="crash-title">{t("界面出错了（已拦下，不用重启）", "The UI hit an error (caught, no restart needed)")}</div>
				<div className="crash-body">
					{t(
						"这一屏是错误边界画出来的：刚才某个组件在渲染时抛了错，React 会把整棵界面卸载掉 —— 那才是白屏。点「重新加载」一般就好了；如果一直复现，把下面的详情复制给我。",
						"An error boundary drew this screen: a component threw while rendering, and React would otherwise unmount everything (that is the blank screen). Reload usually fixes it; if it repeats, copy the details below.",
					)}
				</div>
				<div className="crash-message">{crash.message}</div>
				<details className="crash-detail">
					<summary>{t("堆栈详情", "Stack trace")}</summary>
					<pre>{crash.detail}</pre>
				</details>
				<div className="crash-actions">
					<button type="button" className="crash-btn is-primary" onClick={() => window.location.reload()}>
						{t("重新加载", "Reload")}
					</button>
					<button type="button" className="crash-btn" onClick={copy}>
						{copied ? t("已复制", "Copied") : t("复制错误详情", "Copy details")}
					</button>
				</div>
			</div>
		</div>
	);
}

/** 上一次崩溃的现场（设置 → 「提 Bug」/ 诊断用；没有就返回 null） */
export function lastCrash(): CrashInfo | null {
	return readLastCrash();
}

/**
 * **不接管界面**地记一份现场：给事件回调里抛的错、以及没处理的 Promise 用。
 *
 * 这类错不经过 React（不会白屏），但往往就是「点了没反应」「界面状态乱了」的真凶，
 * 而控制台里的那行字用户根本不会去看 —— 存进 localStorage，下次出事至少有东西可帖。
 */
export function saveCrashReport(error: unknown): void {
	try {
		const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "未捕获的错误");
		console.error("[oh-my-agent-web] 未捕获的错误：", error);
		saveLastCrash({ message: err.message || err.name || "未知错误", detail: err.stack ?? "", at: Date.now() });
	} catch {
		// 连「记现场」都出错就算了：不能因为日志把界面再搞崩一次
	}
}
