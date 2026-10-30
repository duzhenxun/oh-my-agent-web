import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store.ts";
import { setSettings } from "../ws.ts";
import { THEMES, modeOf, type ThemeDef } from "../theme.ts";
import { useTheme } from "../use-theme.ts";
import { useChatDisplay } from "../use-chat-display.ts";
import { CHAT_WIDTHS, CHAT_WIDTH_MIN_PX, CHAT_WIDTH_STEP_PX, chatWidthCap } from "../chat-display.ts";
import { FONT_LADDERS, FONT_MAX_PX, FONT_MIN_PX, FONT_STEP_PX, presetOfPx, type FontLayer } from "../font-scale.ts";
import {
	APPBAR_SCALE_MAX,
	APPBAR_SCALE_MIN,
	APPBAR_SCALE_PRESETS,
	APPBAR_SCALE_STEP,
	presetOfAppbarScale,
} from "../appbar-scale.ts";
import { useAppbarScale } from "../use-appbar-scale.ts";
import { useSidebarFonts } from "../use-sidebar-font.ts";
import {
	THINKING_OPEN_KEY,
	TOOL_OPEN_KEY,
	SELECTION_TOOLBAR_KEY,
	APPBAR_ITEM_LABEL,
	APPBAR_PART_KEY,
	APPBAR_PART_LABEL,
	APPBAR_PARTS,
	APPBAR_TEMPCHAT_KEY,
	APPBAR_TOGGLES,
	COMPOSER_ITEM_KEY,
	COMPOSER_ITEM_LABEL,
	COMPOSER_TOGGLES,
	COST_KEY,
	STATUSBAR_ITEM_KEY,
	STATUSBAR_ITEM_LABEL,
	STATUSBAR_TOGGLES,
	SESSIONS_PER_PROJECT_DEFAULT,
	SESSIONS_PER_PROJECT_KEY,
	SESSIONS_PER_PROJECT_MAX,
	SESSIONS_PER_PROJECT_MIN,
	CHAT_IMAGE_WIDTH_DEFAULT,
	CHAT_IMAGE_WIDTH_KEY,
	TERMINAL_FONT_KEY,
	TERMINAL_FONT_DEFAULT,
	TERMINAL_FONT_MIN,
	TERMINAL_FONT_MAX,
	type AppbarPart,
	type AppbarToggle,
	type ComposerToggle,
	type StatusbarToggle,
} from "../ui-prefs.ts";
import { usePrefFlags } from "../use-pref-flags.ts";
import { showCostDefault } from "../use-show-cost.ts";
import { useStoredBool } from "../use-stored-bool.ts";
import { useStoredNumber } from "../use-stored-number.ts";
import { useAppbarItems } from "../use-appbar-items.ts";
import { useBrandName } from "../use-brand-name.ts";
import { BRAND_NAME_MAX } from "../brand-name.ts";
import { BRAND_NAME } from "../brand.ts";
import { readLogoFile } from "../brand-logo.ts";
import { showToast } from "../toast.ts";

/** 产品自带那张图标（public/favicon.svg）：没换过 logo 时预览里显示它 */
const DEFAULT_LOGO = "/favicon.svg?v=4";
import { useLanguage, useT } from "../use-language.ts";
import { LANGUAGES, type Language } from "../language.ts";
import { PanelIcon } from "./PanelIcon.tsx";
import { SettingsTabStrip } from "./SettingsTabStrip.tsx";
import { defaultSettingsTab, useSettingsTabOrder } from "../settings-tabs.ts";
import { isRemoteAccess, logoutRemote } from "../auth-expiry.ts";
import { fetchAccessPasswordStatus, saveAccessPassword } from "../access-password.ts";
import { ShortcutsPane } from "./ShortcutsPane.tsx";

const DEFAULT_PLACEHOLDER = "继续\n总结一下\n详细解释一下";

/**
 * 设置里那几组勾选框的英文名（中文名在 ui-prefs.ts 里，跟顶栏 / 状态栏按钮共用同一份，
 * 那些位置还没接 i18n，所以这里单独给一张英文表，改动面限制在设置面板内）。
 */
const APPBAR_ITEM_EN: Record<AppbarToggle, string> = {
	models: "Models",
	skills: "Skills",
	push: "Push",
	voice: "Voice",
	plugins: "Plugins",
	mcp: "MCP",
	agents: "Subagents",
};
const COMPOSER_ITEM_EN: Record<ComposerToggle, string> = {
	templates: "Templates",
	think: "Think",
	quick: "Quick phrases",
};
const STATUSBAR_ITEM_EN: Record<StatusbarToggle, string> = {
	queued: "Queued",
	running: "Running",
	context: "Context",
};
const APPBAR_PART_EN: Record<AppbarPart, string> = {
	label: "Show labels",
	icon: "Show icons",
};

type SettingsTab = "general" | "appearance" | "theme" | "language" | "ui" | "shortcuts" | "remote";

/**
 * 设置面板（ADR-0020 §P1）：**内联在侧栏里，不是模态** —— ADR-0013 规定只有审批可以弹模态。
 *
 * 七个 tab（ADR-0030），默认停在「界面」（最常用的一组；也排在最左）：
 *   - **界面**：外框 —— 侧栏、对话里图片的最大宽度、
 *     顶栏（模型 / 技能 / 推送 / 语音 / 插件 / MCP / 子代理）、
 *     顶栏文字与图标（每个入口画不画文案 / 图标，只管顶栏那一排）、
 *     底部状态栏（排队 / 工作中 / 上下文用量）。
 *     全是本机偏好（localStorage）、点一下立刻生效。
 *     「设置」与大屏上压根看不见的东西不在可隐藏之列，否则就再也勾不回来了；
 *   - **对话**（原「通用」）：说的是对话区自己长什么样 ——
 *     对话窗口（模板 / 想想 / 快捷指令 的显隐）、快捷短语内容、想想的参数、
 *     过程（思考块 / 工具卡默认展开）、用量（那几处统计）。
 *     2026-10-29 用户把后三块（用量 / 对话窗口 / 过程）从「界面」搬了过来：
 *     它们不是“壳子”，是对话里的东西。
 *     保存方式两种：快捷短语 / 想想走 `set_settings`（服务端归一化后落盘并推快照，带「保存」按钮）；
 *     其余全是本机偏好，勾一下就生效。
 *     「快捷指令」的显隐以前写服务端（`quickPhrasesEnabled`，多设备一致），
 *     现在归本机：手机想不想看那一行、桌面想不想看，本来就该能不一样。
 *   - **外观**：只讲尺寸 —— 顶栏自称（显示 / 隐藏 / 改名，排第一：改完顶栏立刻看得见）、
 *     三处字号（聊天正文 / 侧栏项目名 / 侧栏会话名，共用 `font-scale.ts` 那张档位表）、
 *     顶栏高度（整条栏的缩放系数，`appbar-scale.ts`）、内容宽度 4 档。
 *   - **主题**：3 浅 + 3 深的色板卡（2026-10-29 从「外观」拆出来的一页）。
 *     这两页都是立刻生效、不用保存，只改本机 `<html data-theme>` / CSS 变量与 `localStorage`。
 *   - **快捷键**：一张表 + 改键 + 冲突提示（`shortcuts.ts`，本机偏好）。
 *   - **远程**：这台服务现在是怎么被访问的（本机 / 域名），**本机可以设 / 改访问密码**，
 *     远程可以**退出登录**。
 *     密码存在数据目录的 `password` 文件里（默认 `~/.oh-my-agent-web/password`），
 *     改完立即生效、不用重启；启动时 `-P` 给的也会写进去。登录态是一张 7 天的 cookie，
 *     没有退出入口的话「在别人电脑上登过一次」就只能等它过期。
 *
 * 「插件」不在这里：它是跟「模型 / 技能 / 推送」并列的一级面板（SidebarMenu 的 plugins）。
 *
 * 「要不要保存按钮」= 这条设置在不在服务端：在服务端就得有明确的提交动作，纯本机偏好则相反
 * （多一个保存步骤只会让人忘了按）。
 */
export function SettingsPanel() {
	/**
	 * 打开时停在**排序里的第一页**（用户 2026-10-29：「哪个在最左边第一个，到时点开设置时就显示它」）。
	 * 初始 state 用惰性求值读一次存储；之后拖拽改了顺序也不强行跳页 ——
	 * 用户正在看的那一页不能因为排序而自己跑掉，只有在下次打开时才会停在新的第一页。
	 */
	const [tab, setTab] = useState<SettingsTab>(defaultSettingsTab);
	const [order, setOrder] = useSettingsTabOrder();
	const t = useT();
	/** 标签文案（顺序由 `order` 决定，见 `settings-tabs.ts`） */
	const labels: Record<SettingsTab, string> = {
		ui: t("界面", "Interface"),
		/* 「通用」改名「对话」（用户 2026-10-29）：这一页只管对话区里那些东西，
		 * 叫「通用」反而看不出里头有什么。id 仍叫 `general`（长存的热键）。 */
		general: t("对话", "Chat"),
		appearance: t("外观", "Appearance"),
		/* 「主题」从「外观」里拆出来单独一页（用户 2026-10-29）：6 套色板是独立的一件事，
		 * 跟字号 / 宽度挤在同一页时，往下滚很久才看到。 */
		theme: t("主题", "Theme"),
		language: t("语言", "Language"),
		shortcuts: t("快捷键", "Shortcuts"),
		remote: t("远程", "Remote"),
	};
	/* 兜底：存储里没有当前页（老版本存的 / 手动改过）时回落到第一页，避免空白面板 */
	const activeTab: SettingsTab = order.includes(tab) ? tab : (order[0] ?? "ui");
	return (
		<div className="settings-stack">
			<SettingsTabStrip
				order={order}
				active={activeTab}
				label={(id) => labels[id]}
				onSelect={(id) => setTab(id)}
				onOrderChange={setOrder}
			/>
			{activeTab === "general" ? (
				<GeneralSettings />
			) : activeTab === "appearance" ? (
				<AppearanceSettings />
			) : activeTab === "theme" ? (
				<ThemeSettings />
			) : activeTab === "language" ? (
				<LanguageSettings />
			) : activeTab === "shortcuts" ? (
				<ShortcutsPane />
			) : activeTab === "remote" ? (
				<RemoteSettings />
			) : (
				<UiSettings />
			)}
		</div>
	);
}

/**
 * 远程：访问方式 + 访问密码（本机可改）+ 退出登录。
 *
 * 背景（用户 2026-10-30）：
 *   ① 「远程访问时，输入密码后可以用，但想退出如何退出呢」—— 服务端早就有
 *      `POST /api/auth/logout`，可界面上一个入口都没有，在别人电脑上登过一次就只能等 cookie 过期；
 *   ② 「密码不用系统变量，存在 ~/.oh-my-agent-web 下面的配置里就行；在访问 127.0.0.1 时，
 *      在 设置/远程 里加个密码输入框来设置」。
 *
 * 所以这一页分两半：
 *   - 本机（免密）：密码输入框 + 保存（打 `/api/auth/password`，落盘后立即生效）；
 *   - 远程：只显示状态 + 退出登录（改密码必须在本机做，服务端也只认本机）。
 * 不限制访问的域名 / 外网 IP / 局域网 IP —— 只要有密码，从哪儿来都能进。
 */
function RemoteSettings() {
	const t = useT();
	const remote = isRemoteAccess();
	const host = typeof location === "undefined" ? "" : location.host;
	/** null = 还没问到（本机才问） */
	const [passwordSet, setPasswordSet] = useState<boolean | null>(null);
	const [statusError, setStatusError] = useState("");
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (remote) return;
		void fetchAccessPasswordStatus().then((result) => {
			if (result.ok) {
				setPasswordSet(result.set);
				setStatusError("");
				return;
			}
			setStatusError(result.error);
		});
	}, [remote]);

	const save = () => {
		const password = draft.trim();
		if (password.length < 4) {
			showToast({ text: t("密码至少 4 位", "Use at least 4 characters") });
			return;
		}
		setSaving(true);
		void saveAccessPassword(password).then((result) => {
			setSaving(false);
			if (!result.ok) {
				showToast({ text: result.error });
				return;
			}
			setPasswordSet(true);
			setStatusError("");
			setDraft("");
			showToast({ text: t("访问密码已保存，立即生效", "Password saved — active now") });
		});
	};

	const stateText =
		passwordSet === null
			? statusError !== ""
				? statusError
				: t("读取中…", "Loading…")
			: passwordSet
				? t("已设置", "Set")
				: t("未设置", "Not set");

	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("访问方式", "Access")}</span>
				<span className="settings-sub">
					{remote
						? t(`通过 ${host} 远程访问`, `Remote — ${host}`)
						: t("本机访问（免密）", "This machine (no password)")}
				</span>
			</div>
			<div className="settings-hint">
				{remote
					? t(
							"远程访问必须输密码；域名 / 外网 IP / 局域网 IP 都能访问，不用再配白名单。改密码请到运行服务的这台机器上（127.0.0.1）的 设置 → 远程。",
							"Remote access always needs the password. Any domain, public IP or LAN IP works — no allowlist. To change it, open Settings → Remote on the machine running the server (127.0.0.1).",
						)
					: t(
							"本机直连（127.0.0.1）不需要密码。设一个之后，远程用任意域名 / 局域网 IP / 隧道地址打开都要先输它。",
							"The local address (127.0.0.1) needs no password. Once set, any remote address — domain, LAN IP or tunnel — will ask for it.",
						)}
			</div>
			{remote ? (
				<div className="settings-row">
					<button type="button" className="btn btn-tiny" onClick={() => logoutRemote()}>
						{t("退出登录", "Sign out")}
					</button>
					<span className="settings-hint">
						{t(
							"清掉这台浏览器上的登录 cookie（有效期 7 天，每次访问顺延）。",
							"Clears the login cookie in this browser (valid 7 days, renewed on every visit).",
						)}
					</span>
				</div>
			) : (
				<>
					<div className="settings-row">
						<span className="settings-field">{t("访问密码", "Password")}</span>
						<input
							className="settings-input settings-password-input"
							type="password"
							value={draft}
							autoComplete="new-password"
							placeholder={
								passwordSet
									? t("输入新密码以修改（至少 4 位）", "New password to change it (min 4)")
									: t("设置访问密码（至少 4 位）", "Set a password (min 4)")
							}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !saving) save();
							}}
						/>
						<button type="button" className="btn btn-tiny" onClick={save} disabled={saving || draft.trim() === ""}>
							{saving ? t("保存中…", "Saving…") : t("保存", "Save")}
						</button>
						<span className="settings-hint">
							{t("当前：", "Now: ")}
							{stateText}
						</span>
					</div>
					<div className="settings-hint">
						{t(
							"密码存在数据目录的 password 文件里（默认 ~/.oh-my-agent-web/password），保存后立即生效，不用重启。忘了就删掉这个文件再重启，或者启动时带 aw -P <新密码>（也会写进去）。",
							"Stored in the data directory's password file (default ~/.oh-my-agent-web/password). It applies immediately — no restart. Forgot it? Delete that file and restart, or start with aw -P <new password> (that is saved too).",
						)}
					</div>
				</>
			)}
		</div>
	);
}

/**
 * 语言：中文 / English（默认中文）。
 *
 * 立刻生效、不用保存 —— 和主题同一类：只改这台机器上的显示。
 * 选项做成两张大卡而不是下拉：只有两种语言，看得见「现在选的是哪个」比少占一行更重要。
 */
function LanguageSettings() {
	const t = useT();
	const { language, setLanguage } = useLanguage();
	return (
		<>
			<div className="settings-panel">
				<div className="settings-head">
					<span>{t("语言", "Language")}</span>
					<span className="settings-sub">{t("界面文字用哪种语言", "Which language the interface uses")}</span>
				</div>
				<div className="settings-langs">
					{LANGUAGES.map((item) => (
						<label
							key={item.id}
							className={`settings-lang${language === item.id ? " settings-lang-on" : ""}`}
							title={item.label}
						>
							<input
								type="radio"
								name="settings-language"
								value={item.id}
								checked={language === item.id}
								onChange={() => setLanguage(item.id as Language)}
							/>
							<span className="settings-lang-name">{item.label}</span>
							<span className="settings-lang-hint">
								{item.id === "zh" ? t("默认", "Default") : t("Beta · 逐块补齐中", "Beta · being filled in")}
							</span>
						</label>
					))}
				</div>
				<div className="settings-hint">
					{t(
						"点一下立即生效，不用保存。选择存在本机（localStorage），刷新后保持，不影响服务端和其它设备；首次使用是中文。",
						"Takes effect immediately, nothing to save. The choice is stored on this machine (localStorage) and survives reloads; it does not touch the server or your other devices. Chinese is the default.",
					)}
				</div>
			</div>
		</>
	);
}

/**
 * 对话：输入框上方那排的开关 + 它们的配置 + 对话区里的统计 / 过程。
 *
 * 2026-10-29 用户把「用量 / 对话窗口 / 过程」三块从「界面」搬到这里（当时叫「通用」、随后改名「对话」）：
 * 这三块全是“对话里长什么样”的事，跟左边栏 / 顶栏 / 底栏那种“外框”不是一类。
 * 顺序按“从输入框往外看”：输入框上方那排（对话窗口）→ 那排里的内容（快捷短语 / 想想）→
 * 对话区里的过程卡片 → 对话里的统计（用量）。
 *
 * 两类设置的保存方式不同，并排放着也不乱：快捷短语 / 想想走服务端（带「保存」按钮），
 * 其余全是本机偏好（勾一下就生效）。
 */
function GeneralSettings() {
	const t = useT();
	const { snapshot } = useAppState();
	const [text, setText] = useState("");
	const [dirty, setDirty] = useState(false);

	const phrases = snapshot?.settings.quickPhrases ?? [];

	// 打开面板时用当前设置初始化；服务端推回新设置时若用户没在编辑，就跟着更新
	useEffect(() => {
		if (dirty) return;
		setText(phrases.join("\n"));
	}, [phrases, dirty]);

	const save = () => {
		setSettings({ quickPhrases: text.split(/\r?\n/) });
		setDirty(false);
	};

	// ---- 想想 ----
	const thinkCount = snapshot?.settings.thinkCount ?? 5;
	const thinkTimeoutSec = snapshot?.settings.thinkTimeoutSec ?? 20;
	const [thinkDraft, setThinkDraft] = useState({ count: thinkCount, timeoutSec: thinkTimeoutSec });
	const [thinkDirty, setThinkDirty] = useState(false);

	useEffect(() => {
		if (thinkDirty) return;
		setThinkDraft({ count: thinkCount, timeoutSec: thinkTimeoutSec });
	}, [thinkCount, thinkTimeoutSec, thinkDirty]);

	const saveThink = () => {
		setSettings({ thinkCount: thinkDraft.count, thinkTimeoutSec: thinkDraft.timeoutSec });
		setThinkDirty(false);
	};

	return (
		<>
			{/* 勾选控件放最前：它是下面两块的“总开关”（不显示那排，下面的内容也就无所谓了） */}
			<ComposerSettings />
			<div className="settings-panel">
				<div className="settings-head">
					<span>{t("快捷短语", "Quick phrases")}</span>
					<span className="settings-sub">{t("输入框上方那一排按钮", "The row of buttons above the input")}</span>
					{/* 保存放在标题行：它只管这一块，且改完多数字段一眼就想点 —— 压在说明下面还得先找到底 */}
					<button type="button" className="btn btn-tiny settings-head-action" onClick={save} disabled={!dirty}>
						{t("保存", "Save")}
					</button>
				</div>
				<textarea
					className="settings-textarea"
					value={text}
					placeholder={DEFAULT_PLACEHOLDER}
					onChange={(event) => {
						setText(event.target.value);
						setDirty(true);
					}}
					rows={5}
				/>
				<div className="settings-hint">
					{t(
						"一行一条（最多 30 条，每条 200 字）。保存后立即生效。",
						"One per line (up to 30, 200 characters each). Saved changes apply immediately.",
					)}
				</div>
			</div>

			<div className="settings-panel">
				<div className="settings-head">
					<span>{t("想想", "Think")}</span>
					<span className="settings-sub">{t("下一步建议", "Next-step suggestions")}</span>
					<button
						type="button"
						className="btn btn-tiny settings-head-action"
						onClick={saveThink}
						disabled={!thinkDirty}
					>
						{t("保存", "Save")}
					</button>
				</div>
				<div className="settings-row">
					<label className="settings-field">
						<span>{t("一次生成", "Generate")}</span>
						<input
							className="settings-number"
							type="number"
							inputMode="numeric"
							min={1}
							max={5}
							value={thinkDraft.count}
							onChange={(event) => {
								const value = Number(event.target.value);
								if (!Number.isFinite(value)) return;
								setThinkDraft((draft) => ({ ...draft, count: Math.min(5, Math.max(1, Math.round(value))) }));
								setThinkDirty(true);
							}}
						/>
						<span>{t("条", "items")}</span>
					</label>
					<label className="settings-field">
						<span>{t("最多等", "Wait up to")}</span>
						<input
							className="settings-number"
							type="number"
							inputMode="numeric"
							min={5}
							max={180}
							step={5}
							value={thinkDraft.timeoutSec}
							onChange={(event) => {
								const value = Number(event.target.value);
								if (!Number.isFinite(value)) return;
								setThinkDraft((draft) => ({
									...draft,
									timeoutSec: Math.min(180, Math.max(5, Math.round(value))),
								}));
								setThinkDirty(true);
							}}
						/>
						<span>{t("秒", "s")}</span>
					</label>
				</div>
				<div className="settings-hint">
					{t(
						"「想想」用一次隐藏回合让模型出建议（不进对话）。超过这个时间还没出结果就中断，可以再点一次。",
						"Think runs a hidden turn to get suggestions (it never enters the conversation). If it takes longer than this, the turn is aborted and you can click again.",
					)}
				</div>
			</div>

			{/* 这两块原在「界面」tab（用户 2026-10-29：「这几块都移动到对话里去」）：
			 * 说的都是对话区本身，跟顶栏 / 侧栏同为“本机偏好、点一下生效”。
			 * 「标注」排在它们前面：它管的是「选字之后那一小下」，比过程卡片更靠近正文。 */}
			<AnnotationSettings />
			<ProcessSettings />
			<UsageSettings />
		</>
	);
}

/**
 * 标注：在对话里**选中一段文字**后浮出来的那颗小工具栏（添加到会话 / 标注 / 在临时会话中提问）
 * 要不要弹。纯本机偏好，勾一下立即生效（见 `ui-prefs.ts` 的 `SELECTION_TOOLBAR_KEY`）。
 *
 * 只管「弹不弹」：已经标好的引用 + 编号、输入框里那行「N 条注释」都不受影响 ——
 * 那已经是会话的内容了，把开关关掉不该让历史里的标注一夜之间消失。
 */
function AnnotationSettings() {
	const t = useT();
	const [on, setOn] = useStoredBool(SELECTION_TOOLBAR_KEY, true);
	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("标注", "Annotations")}</span>
				<span className="settings-sub">
					{t("选中文字后浮出的小工具栏", "The toolbar that pops up on text selection")}
				</span>
			</div>
			<div className="settings-checks">
				<label className="settings-toggle settings-check">
					<input type="checkbox" checked={on} onChange={(event) => setOn(event.target.checked)} />
					<span className="settings-check-icon" aria-hidden="true">
						✍️
					</span>
					{t("开启选中标注", "Enable selection annotations")}
				</label>
			</div>
			<div className="settings-hint">
				{t(
					"打开时，在对话里选中一段文字会浮出「添加到会话 / 标注 / 在临时会话中提问」；关掉后选字就只是选字（复制、搜索都不受打扰）。已标好的内容照旧显示。只存本机，手机和桌面各记各的。",
					"On: selecting text in the conversation shows Add to session / Annotate / Ask in the side chat. Off: selecting text is just selecting (copying stays unobstructed). Existing annotations are kept. Stored per device.",
				)}
			</div>
		</div>
	);
}

/** 过程：对话区里那两类卡片默认展开与否（原「对话」tab，现并入「对话」页的最后一组） */
function ProcessSettings() {
	const t = useT();
	const [thinkingOpen, setThinkingOpen] = useStoredBool(THINKING_OPEN_KEY, false);
	const [toolOpen, setToolOpen] = useStoredBool(TOOL_OPEN_KEY, false);
	return (
		<>
			<div className="settings-panel">
				<div className="settings-head">
					<span>{t("过程", "Process")}</span>
					<span className="settings-sub">{t("思考块 + 工具卡", "Thinking blocks + tool cards")}</span>
				</div>
				<label className="settings-toggle">
					<input type="checkbox" checked={thinkingOpen} onChange={(event) => setThinkingOpen(event.target.checked)} />
					{t("默认展开思考块", "Expand thinking blocks by default")}
				</label>
				<label className="settings-toggle">
					<input type="checkbox" checked={toolOpen} onChange={(event) => setToolOpen(event.target.checked)} />
					{t("默认展开工具卡", "Expand tool cards by default")}
				</label>
				<div className="settings-hint">
					{t(
						"打开后新出现的内容直接铺开：思考块给全文，工具卡给参数 / 命令和输出。 单独点过的那一块以你点的那次为准。",
						"When on, new blocks arrive already expanded: full thinking text, and tool cards with arguments/command and output. Blocks you toggled yourself keep your choice.",
					)}
				</div>
			</div>
		</>
	);
}

/**
 * 界面：侧栏 + 顶栏 + 底栏 —— 都是“外框”这类事。
 *
 * 分组跟界面上那几块一一对应，用户找东西的顺序也是这个：先看左边那一栏（侧栏里有几条会话）、
 * 再看上面、再看下面。
 * 全是本机偏好，点一下立刻生效、不用保存。
 *
 * 2026-10-29 用户把「用量 / 对话窗口 / 过程」三块搬到了「对话」tab（说的都是对话区自己长什么样）；
 * 同一天又把「对话里图片的最大宽度」搬到了「外观」，紧跟在「聊天字体大小」下面 ——
 * 那也是"读对话时字和图多大"的事，跟字号是一类，不该留在"壳子"里。
 */
function UiSettings() {
	return (
		<>
			<SidebarSettings />
			<AppbarSettings />
			<AppbarPartsSettings />
			<StatusbarSettings />
		</>
	);
}

/**
 * 对话里的图片：最大宽度几档（默认 400）。
 *
 * 为什么给几档按钮而不是输入框：这是「看着舒不舒服」的事，试一下就知道，
 * 没人想记一个像素值。320 以下截图里的字开始糊、720 以上又回到「占满气泡」，所以中间留四档 + 原尺寸。
 * 用 `.settings-lang*` 那套卡片（跟「聊天内容宽度」同一个样式）：选中态一眼看得见。
 */
const CHAT_IMAGE_OPTIONS: { value: number; label: string; labelEn: string }[] = [
	{ value: 320, label: "小", labelEn: "S" },
	{ value: 400, label: "中", labelEn: "M" },
	{ value: 520, label: "大", labelEn: "L" },
	{ value: 720, label: "特大", labelEn: "XL" },
	{ value: 0, label: "原尺寸", labelEn: "Natural" },
];

function ChatImageSettings() {
	const t = useT();
	const [width, setWidth] = useStoredNumber(CHAT_IMAGE_WIDTH_KEY, CHAT_IMAGE_WIDTH_DEFAULT, 0, 4000);
	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("图片", "Images")}</span>
				<span className="settings-sub">{t("对话里图片的最大显示宽度", "Max width of images in the chat")}</span>
			</div>
			<div className="settings-langs settings-langs-5">
				{CHAT_IMAGE_OPTIONS.map((option) => (
					<label
						key={option.value}
						className={`settings-lang${width === option.value ? " settings-lang-on" : ""}`}
						title={option.value > 0 ? `${option.value}px` : t("不额外收窄，按图片本身大小", "No extra cap")}
					>
						<input
							type="radio"
							name="settings-chat-image-width"
							value={option.value}
							checked={width === option.value}
							onChange={() => setWidth(option.value)}
						/>
						<span className="settings-lang-name">{t(option.label, option.labelEn)}</span>
						<span className="settings-lang-hint">
							{option.value > 0 ? `${option.value}px` : t("不设上限", "No cap")}
						</span>
					</label>
				))}
			</div>
			<div className="settings-hint">
				{t(
					"截图先按设备像素比折回真实大小，再套这个上限；点图仍可看原图。改完立刻生效，不用保存。",
					"Screenshots are first scaled back to their real size, then capped by this width. Click an image for the original. Applies immediately, nothing to save.",
				)}
			</div>
		</div>
	);
}

/**
 * 侧栏：每个项目默认摆几个会话（其余折成一行「还有 N 个…」）。
 *
 * 为什么可调：侧栏就那么点高，而「看几条算够」跟屏幕高度、项目数都相关 ——
 * 10 是个好默认，不是个好硬编码。输入框直接夹到 1–50（手动改 localStorage 也不会弄出一张长图）。
 */
function SidebarSettings() {
	const t = useT();
	const [count, setCount] = useStoredNumber(
		SESSIONS_PER_PROJECT_KEY,
		SESSIONS_PER_PROJECT_DEFAULT,
		SESSIONS_PER_PROJECT_MIN,
		SESSIONS_PER_PROJECT_MAX,
	);
	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("侧栏", "Sidebar")}</span>
				<span className="settings-sub">{t("每个项目摆多少会话", "Sessions per project")}</span>
			</div>
			<div className="settings-row">
				<label className="settings-field">
					<span>{t("每个项目显示", "Show")}</span>
					<input
						className="settings-number"
						type="number"
						inputMode="numeric"
						min={SESSIONS_PER_PROJECT_MIN}
						max={SESSIONS_PER_PROJECT_MAX}
						value={count}
						onChange={(event) => {
							const value = Number(event.target.value);
							if (Number.isFinite(value)) setCount(value);
						}}
					/>
					<span>{t("条", "sessions")}</span>
				</label>
			</div>
			<div className="settings-hint">
				{t(
					`默认 ${SESSIONS_PER_PROJECT_DEFAULT} 条，范围 ${SESSIONS_PER_PROJECT_MIN}–${SESSIONS_PER_PROJECT_MAX}。超出的折成一行「还有 N 个…」，点一下全展开。改完立刻生效，不用保存。`,
					`Default ${SESSIONS_PER_PROJECT_DEFAULT}, range ${SESSIONS_PER_PROJECT_MIN}–${SESSIONS_PER_PROJECT_MAX}. The rest collapse into one “and N more…” row that expands on click. Applies immediately, nothing to save.`,
				)}
			</div>
		</div>
	);
}

/** 顶栏：勾上才在顶部那一排显示（纯本机偏好，点一下立刻生效、不用保存） */
function AppbarSettings() {
	const t = useT();
	const [visible, setVisible] = useAppbarItems();
	// 「临时会话」不是面板（它是个动作：在右侧新开一条聊天），单独一个 key
	const [tempChat, setTempChat] = useStoredBool(APPBAR_TEMPCHAT_KEY, true);
	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("顶栏", "Top bar")}</span>
				<span className="settings-sub">{t("那一排入口显示哪些", "Which entries that row shows")}</span>
			</div>
			<div className="settings-checks">
				{APPBAR_TOGGLES.map((item) => (
					<label className="settings-toggle settings-check" key={item}>
						<input
							type="checkbox"
							checked={visible[item]}
							onChange={(event) => setVisible(item, event.target.checked)}
						/>
						{/* 图标跟顶栏上那颗是同一个（面板走 PanelIcon），勾的就是你看到的那个按钮 */}
						<span className="settings-check-icon" aria-hidden="true">
							<PanelIcon name={item} />
						</span>
						{t(APPBAR_ITEM_LABEL[item], APPBAR_ITEM_EN[item])}
					</label>
				))}
				{/* 「临时会话」排在这一排的最后：它不属于「打开哪个面板」那一类，
				    图标直接用顶栏那颗 💬（`TempChatButton`），勾的就是你看到的那个按钮 */}
				<label className="settings-toggle settings-check">
					<input type="checkbox" checked={tempChat} onChange={(event) => setTempChat(event.target.checked)} />
					<span className="settings-check-icon" aria-hidden="true">
						💬
					</span>
					{t("临时会话", "Temp session")}
				</label>
			</div>
		</div>
	);
}

/**
 * 顶栏入口的「长什么样」：文案 / 图标各一个开关（纯本机偏好，点一下立刻生效）。
 *
 * 单独一张卡而不是塞进上面那张：上面那张回答「显不显示这一项」，这张回答「显示了长什么样」，
 * 两个问题一份清单混在一起，勾起来会分不清自己刚关掉的是入口还是它的字。
 * 只作用于顶栏；侧栏底部那排 / 弹窗 tab 不受影响。
 */
function AppbarPartsSettings() {
	const t = useT();
	const [shown, setShown] = usePrefFlags(APPBAR_PARTS, APPBAR_PART_KEY);
	const icons: Record<AppbarPart, string> = { label: "文", icon: "图" };
	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("顶栏文字与图标", "Top bar labels & icons")}</span>
				<span className="settings-sub">{t("每个入口显示什么", "What each entry shows")}</span>
			</div>
			<div className="settings-checks">
				{APPBAR_PARTS.map((part) => (
					<label className="settings-toggle settings-check" key={part}>
						<input type="checkbox" checked={shown[part]} onChange={(event) => setShown(part, event.target.checked)} />
						<span className="settings-check-icon" aria-hidden="true">
							{icons[part]}
						</span>
						{t(APPBAR_PART_LABEL[part], APPBAR_PART_EN[part])}
					</label>
				))}
			</div>
			<div className="settings-hint">
				{t(
					"只影响顶栏那一排。两个都不勾时仍然画图标 —— 一排看不见的按钮就等于把入口弄丢了。",
					"Top bar row only. With both off the icon still shows: a row of invisible buttons would just lose the entries.",
				)}
			</div>
		</div>
	);
}

/** 底部：状态栏里三块信息的显隐（纯本机偏好）。审批与「顶部」开关不在可隐藏之列 */
function StatusbarSettings() {
	const t = useT();
	const [visible, setVisible] = usePrefFlags(STATUSBAR_TOGGLES, STATUSBAR_ITEM_KEY);
	const icons: Record<StatusbarToggle, string> = { queued: "⏳", running: "⚙️", context: "◔" };
	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("底部", "Bottom")}</span>
				<span className="settings-sub">{t("状态栏里那几块信息", "The readouts in the status bar")}</span>
			</div>
			<div className="settings-checks">
				{STATUSBAR_TOGGLES.map((item) => (
					<label className="settings-toggle settings-check" key={item}>
						<input
							type="checkbox"
							checked={visible[item]}
							onChange={(event) => setVisible(item, event.target.checked)}
						/>
						<span className="settings-check-icon" aria-hidden="true">
							{icons[item]}
						</span>
						{t(STATUSBAR_ITEM_LABEL[item], STATUSBAR_ITEM_EN[item])}
					</label>
				))}
			</div>
			<div className="settings-hint">
				{t(
					"「审批模式」和右边的「顶部」开关始终留着 —— 它们是操作入口，不是一块信息。",
					"Approval mode and the “Top” toggle on the right always stay: they are controls, not readouts.",
				)}
			</div>
		</div>
	);
}

/**
 * 用量：金额（$）显不显示 —— 子代理卡片条 / 顶栏浮层 / 消息尾注上的那些数字。
 *
 * 默认值按设备给：**手机默认不显示**（那一行本来就挤），桌面上默认显示。
 * 仍然是本机偏好，手机勾上只影响手机。
 */
function UsageSettings() {
	const t = useT();
	const [showCost, setShowCost] = useStoredBool(COST_KEY, showCostDefault());
	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("用量", "Usage")}</span>
				<span className="settings-sub">{t("对话里那几处统计", "The readouts inside the conversation")}</span>
			</div>
			<div className="settings-checks">
				<label className="settings-toggle settings-check">
					<input type="checkbox" checked={showCost} onChange={(event) => setShowCost(event.target.checked)} />
					<span className="settings-check-icon" aria-hidden="true">
						💲
					</span>
					{t("花费", "Cost")}
				</label>
			</div>
			<div className="settings-hint">
				{t(
					"手机上默认不勾（一行放不下的那点宽度留给 token 和耗时）；桌面上默认勾上。手机和桌面各记各的。",
					"Off by default on phones (that width goes to tokens and duration), on by default on desktop. Stored per device.",
				)}
			</div>
		</div>
	);
}

/** 对话窗口：输入框上方那三块（模板 / 想想 / 快捷指令）的显隐 —— 都是本机偏好 */
function ComposerSettings() {
	const t = useT();
	const [visible, setVisible] = usePrefFlags(COMPOSER_TOGGLES, COMPOSER_ITEM_KEY);
	const icons: Record<ComposerToggle, string> = { templates: "🧩", think: "💡", quick: "⚡" };
	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("对话窗口", "Composer")}</span>
				<span className="settings-sub">{t("输入框上方那一排", "The row above the input")}</span>
			</div>
			<div className="settings-checks">
				{COMPOSER_TOGGLES.map((item) => (
					<label className="settings-toggle settings-check" key={item}>
						<input
							type="checkbox"
							checked={visible[item]}
							onChange={(event) => setVisible(item, event.target.checked)}
						/>
						<span className="settings-check-icon" aria-hidden="true">
							{icons[item]}
						</span>
						{t(COMPOSER_ITEM_LABEL[item], COMPOSER_ITEM_EN[item])}
					</label>
				))}
			</div>
			<div className="settings-hint">
				{t(
					"这三块都只存本机 —— 手机、平板、桌面各一份，同一条设置在不同设备上可以不一样。快捷指令的短语内容在本页「快捷短语」里改（那份是多设备一致的），这里只管要不要在输入框上方显示。",
					"These three are stored per device — phone, tablet and desktop can differ. The phrase text itself is edited under Quick phrases on this page (shared across devices); this only controls whether the row is shown.",
				)}
			</div>
		</div>
	);
}

/**
 * 顶栏自称：logo 后面那串名字的**显示 / 隐藏**与**改名**（纯本机偏好，跟主题同一类）。
 *
 * 不用保存按钮：输入框每敲一个字就写本机、顶栏立刻跟着变 —— 想看到效果不用先按保存。
 * 隐藏只管顶栏那一处（省宽度）；名字本身还会出现在浏览器标签页和新会话抬头，
 * 那里换的是"叫什么"，不是"露不露脸"。
 *
 * 留空 = 恢复默认名（而不是显示一片空白）：placeholder 里就是那个默认名字，
 * 所以"清空输入框"这个动作的含义一眼看得出来。
 */
function BrandSettings() {
	const t = useT();
	const { custom, shown, logo, logoShown, setName, setShown, setLogo, setLogoShown, reset } = useBrandName();
	// 输入框自己拿着一份草稿：用户正在敲的时候不被自己的 round-trip 覆盖（尾部空格会被清洗掉）
	const [draft, setDraft] = useState(custom);
	/** 「更换 logo」那个隐藏的文件选择框 */
	const fileRef = useRef<HTMLInputElement | null>(null);
	const [editing, setEditing] = useState(false);
	useEffect(() => {
		if (editing) return;
		setDraft(custom);
	}, [custom, editing]);
	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("顶栏名称", "Top-bar name")}</span>
				<span className="settings-sub">
					{t("顶栏那个 logo 和它后面那串名字", "The logo in the top bar and the name after it")}
				</span>
			</div>
			<label className="settings-toggle">
				<input type="checkbox" checked={logoShown} onChange={(event) => setLogoShown(event.target.checked)} />
				{t("在顶栏显示 logo", "Show the logo in the top bar")}
			</label>
			{/* 换 logo：预览 + 选择文件 + 恢复默认。
			 * 图片在浏览器里先缩到 192px 再存本机（见 brand-logo.ts）—— localStorage 装不下原图。 */}
			<div className="brand-logo-row">
				<img className="brand-logo-preview" src={logo || DEFAULT_LOGO} alt="" aria-hidden="true" />
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => fileRef.current?.click()}
					title={t(
						"选一张图片当顶栏 logo（会缩到 192px 存在本机）",
						"Pick an image as the top-bar logo (scaled to 192px, stored on this device)",
					)}
				>
					{t("更换 logo", "Change logo")}
				</button>
				{logo ? (
					<button type="button" className="btn btn-tiny" onClick={() => setLogo("")}>
						{t("用回默认 logo", "Use default logo")}
					</button>
				) : null}
				<input
					ref={fileRef}
					className="brand-logo-file"
					type="file"
					accept="image/*"
					aria-label={t("选择 logo 图片", "Choose a logo image")}
					onChange={(event) => {
						const file = event.target.files?.[0];
						// 同一个文件连选两次也要能触发 change：读完就把 value 清空
						event.target.value = "";
						if (!file) return;
						void readLogoFile(file)
							.then((dataUrl) => setLogo(dataUrl))
							.catch((error: unknown) => {
								showToast({
									text: error instanceof Error ? error.message : t("这张图用不了", "That image did not work"),
								});
							});
					}}
				/>
			</div>
			<label className="settings-toggle">
				<input type="checkbox" checked={shown} onChange={(event) => setShown(event.target.checked)} />
				{t("在顶栏显示名称", "Show the name in the top bar")}
			</label>
			<input
				className="settings-input"
				type="text"
				value={draft}
				maxLength={BRAND_NAME_MAX}
				placeholder={BRAND_NAME}
				aria-label={t("顶栏名称", "Top-bar name")}
				onFocus={() => setEditing(true)}
				onBlur={() => setEditing(false)}
				onChange={(event) => {
					setDraft(event.target.value);
					setName(event.target.value);
				}}
			/>
			{/* 没改过名就不占一行：常驻一个永远灰着的按钮，只会让人以为「还能恢复到别的什么」 */}
			{custom === "" ? null : (
				<div className="settings-actions">
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => {
							setDraft("");
							reset();
						}}
					>
						{t("恢复默认", "Restore default")}
					</button>
				</div>
			)}
			<div className="settings-hint">
				{t(
					"边输边生效，不用保存；换 logo 也一样。两个勾选都只影响顶栏（都关掉就只剩「新会话」，宽度全让它）；名字还会用到浏览器标签页、新会话抬头和推送通知标题（改名后自动同步到这台设备自己的那条推送订阅）。留空 = 用默认名，logo 也能随时用回默认那张。",
					"Applies as you type, nothing to save — same for the logo. Both checkboxes only affect the top bar (turning both off leaves just “New session”); the name is also used for the browser tab, the new-session header and push notification titles (a rename syncs to this device's own push subscription). Empty = the default name, and the logo can always be restored to the default one.",
				)}
			</div>
		</div>
	);
}

/**
 * 一处字号的调节器：**滑杆（连续）+ 四个快捷档**（聊天正文 / 侧栏项目名 / 侧栏会话名三处共用）。
 *
 * 为什么两样都给：档位好按、但"我就想 15.5px"只能靠滑杆；反过来只有滑杆又要拖着找"标准"。
 * 滑杆是主路径（步长 2px，只出双数），四个档只是"一键回到常用值"，正好等于滑杆上某个刻度时高亮。
 * 两者改的是**同一个值**，所以不存在"卡片和滑杆各说一套"。
 */
function FontSizeControl({
	name,
	layer,
	value,
	onChange,
}: {
	/** 滑杆的 id（label 的 htmlFor 用，三处各自唯一） */
	name: string;
	/** 哪一处（决定快捷档表：项目名那一套的「标准」比别处大一档） */
	layer: FontLayer;
	/** 当前字号（像素） */
	value: number;
	onChange: (px: number) => void;
}) {
	const t = useT();
	const preset = presetOfPx(value, layer);
	const presets = FONT_LADDERS[layer];
	return (
		<>
			<div className="settings-font-slider">
				<span className="settings-font-label">{t("自定义", "Custom")}</span>
				{/* 滑杆 + 两端刻度：没有刻度时"还能不能更小/更大"要靠拖到头才知道 */}
				<div className="settings-font-track">
					<input
						id={name}
						type="range"
						min={FONT_MIN_PX}
						max={FONT_MAX_PX}
						step={FONT_STEP_PX}
						value={value}
						aria-label={t(`字号（${FONT_MIN_PX}–${FONT_MAX_PX} 像素）`, `Font size (${FONT_MIN_PX}–${FONT_MAX_PX} px)`)}
						aria-valuetext={`${value}px`}
						// 拖的时候立刻生效：侧栏 / 正文就在旁边，能直接看到大小对不对
						onChange={(event) => onChange(Number(event.target.value))}
					/>
					<div className="settings-font-bounds" aria-hidden="true">
						<span>{FONT_MIN_PX}px</span>
						<span>{FONT_MAX_PX}px</span>
					</div>
				</div>
				<span className="settings-font-value mono">{value}px</span>
			</div>
			<div className="settings-langs settings-langs-4">
				{presets.map((item) => (
					<label
						key={item.id}
						className={`settings-lang${preset === item.id ? " settings-lang-on" : ""}`}
						title={t(`一键设为 ${item.px}px`, `Set to ${item.px}px`)}
					>
						<input
							type="radio"
							// 三个面板各一组：名字带上滑杆 id，互不干扰
							name={`${name}-preset`}
							value={item.id}
							checked={preset === item.id}
							onChange={() => onChange(item.px)}
						/>
						<span className="settings-lang-name" style={{ fontSize: `${item.px}px` }}>
							{t(item.label, item.labelEn)}
						</span>
						<span className="settings-lang-hint">{item.px}px</span>
					</label>
				))}
			</div>
		</>
	);
}

/**
 * 聊天内容宽度的滑杆 + 四档快捷卡。
 *
 * 2026-10-30 用户：「也加一个滑动条吧，但最大只能是满屏」——
 * 所以右端就是 `chatWidthCap()` 量出来的**满屏**（对话区可用宽度）：拖到最右 = 满宽（存 0）。
 * 四档卡片保留（点一下就到位，省得拖着找），与字号 / 顶栏高度那几块同一套版式。
 */
function ChatWidthControl({ value, onChange }: { value: number; onChange: (px: number) => void }) {
	const t = useT();
	// 打开面板时量一次：面板本身是浮层，对话区还在 DOM 里，量得到真值
	const [cap, setCap] = useState(chatWidthCap);
	useEffect(() => {
		// 开面板之后又转过屏 / 改过侧栏宽度：重开后重新量（不必监听 resize，面板是每次重渲染的）
		setCap(chatWidthCap());
	}, []);
	/** `0` 与「已经拖到上限」都是满宽：两种状态在界面上必须长得一样 */
	const full = value <= 0 || value >= cap;
	const sliderValue = full ? cap : value;
	return (
		<>
			<div className="settings-font-slider">
				<span className="settings-font-label">{t("自定义", "Custom")}</span>
				<div className="settings-font-track">
					<input
						id="settings-chat-width"
						type="range"
						min={CHAT_WIDTH_MIN_PX}
						max={cap}
						step={CHAT_WIDTH_STEP_PX}
						value={sliderValue}
						aria-label={t(
							`内容宽度（${CHAT_WIDTH_MIN_PX}px 到满宽）`,
							`Content width (${CHAT_WIDTH_MIN_PX}px to full)`,
						)}
						aria-valuetext={full ? t("满宽", "Full width") : `${sliderValue}px`}
						// 拖的时候立刻生效：正文就在浮层后面，能直接看到一行有多长
						onChange={(event) => {
							const next = Number(event.target.value);
							// 拖到右端 = 满宽（存 0 = 不限制）：这样“最大只能是满屏”是滑杆本身就保证的
							onChange(next >= cap ? 0 : next);
						}}
					/>
					<div className="settings-font-bounds" aria-hidden="true">
						<span>{CHAT_WIDTH_MIN_PX}px</span>
						<span>{t("满宽", "Full width")}</span>
					</div>
				</div>
				<span className="settings-font-value mono">{full ? t("满宽", "Full") : `${value}px`}</span>
			</div>
			<div className="settings-langs settings-langs-4">
				{CHAT_WIDTHS.map((item) => (
					<label
						key={item.id}
						className={`settings-lang${item.px === value ? " settings-lang-on" : ""}`}
						title={item.px > 0 ? `${item.px}px` : t("铺满整个对话区", "Fill the whole area")}
					>
						<input
							type="radio"
							name="settings-chat-width"
							value={item.id}
							checked={item.px === value}
							onChange={() => onChange(item.px)}
						/>
						<span className="settings-lang-name">{t(item.label, item.labelEn)}</span>
						<span className="settings-lang-hint">{item.px > 0 ? `${item.px}px` : t("默认", "Default")}</span>
					</label>
				))}
			</div>
		</>
	);
}

/**
 * 顶栏高度（整条栏的缩放系数，见 `appbar-scale.ts`）。
 *
 * 和字号那几块用同一套「滑杆 + 四档快捷卡」：滑杆负责"我就要 90% 这种"，
 * 四档只是点一下就到位。改的是 `<html>` 上的 `--appbar-scale`，顶栏就在上面一排，
 * 拖的时候直接看得见高度对不对，所以没有「保存」按钮（与主题 / 字号同理）。
 */
function AppbarScaleControl() {
	const t = useT();
	const { percent, setPercent } = useAppbarScale();
	const preset = presetOfAppbarScale(percent);
	return (
		<>
			<div className="settings-font-slider">
				<span className="settings-font-label">{t("自定义", "Custom")}</span>
				<div className="settings-font-track">
					<input
						id="settings-appbar-scale"
						type="range"
						min={APPBAR_SCALE_MIN}
						max={APPBAR_SCALE_MAX}
						step={APPBAR_SCALE_STEP}
						value={percent}
						aria-label={t(
							`顶栏大小（${APPBAR_SCALE_MIN}%–${APPBAR_SCALE_MAX}%）`,
							`Top bar size (${APPBAR_SCALE_MIN}%–${APPBAR_SCALE_MAX}%)`,
						)}
						aria-valuetext={`${percent}%`}
						// 拖的时候立刻生效：顶栏就在上面，能直接看到高度对不对
						onChange={(event) => setPercent(Number(event.target.value))}
					/>
					<div className="settings-font-bounds" aria-hidden="true">
						<span>{APPBAR_SCALE_MIN}%</span>
						<span>{APPBAR_SCALE_MAX}%</span>
					</div>
				</div>
				<span className="settings-font-value mono">{percent}%</span>
			</div>
			<div className="settings-langs settings-langs-4">
				{APPBAR_SCALE_PRESETS.map((item) => (
					<label
						key={item.id}
						className={`settings-lang${preset === item.id ? " settings-lang-on" : ""}`}
						title={t(`一键设为 ${item.percent}%`, `Set to ${item.percent}%`)}
					>
						<input
							type="radio"
							name="settings-appbar-scale-preset"
							value={item.id}
							checked={preset === item.id}
							onChange={() => setPercent(item.percent)}
						/>
						<span className="settings-lang-name">{t(item.label, item.labelEn)}</span>
						<span className="settings-lang-hint">{item.percent}%</span>
					</label>
				))}
			</div>
		</>
	);
}

/** 一张主题卡：三色预览 + 名字 + 一句说明。点一下立刻切换（没有「保存」） */
function ThemeCard({ theme, active, onPick }: { theme: ThemeDef; active: boolean; onPick: () => void }) {
	return (
		<button
			type="button"
			className={`theme-card${active ? " theme-card-on" : ""}`}
			aria-pressed={active}
			title={`${theme.name} — ${theme.hint}`}
			onClick={onPick}
		>
			{/* 预览块直接用色板里的三种颜色画，不额外维护一套缩略图 */}
			<span className="theme-preview" style={{ background: theme.swatch[0] }}>
				<span className="theme-preview-bar" style={{ background: theme.swatch[1] }} />
				<span className="theme-preview-bar theme-preview-bar-short" style={{ background: theme.swatch[1] }} />
				<span className="theme-preview-dot" style={{ background: theme.swatch[2] }} />
			</span>
			<span className="theme-name">
				{theme.name}
				{active ? (
					<span className="theme-check" aria-hidden="true">
						✓
					</span>
				) : null}
			</span>
			<span className="theme-hint">{theme.hint}</span>
		</button>
	);
}

/**
 * 右侧终端（xterm）的字号：8–24px，默认 12。
 *
 * 只影响 `TerminalPanel` 里的那一路终端；改完**立刻生效**（终端里也能 ⌘/Ctrl + 滚轮 / `=` `-` 调，
 * 两边写的是同一份本机偏好，所以不会出现「设置里改了、终端里滚一下又变回去」）。
 * 滑杆和数字走同一套 `settings-font-slider` 样式，跟上面三处字号看起来是一家的。
 */
function TerminalFontSettings() {
	const t = useT();
	const [px, setPx] = useStoredNumber(TERMINAL_FONT_KEY, TERMINAL_FONT_DEFAULT, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX);
	return (
		<div className="settings-panel">
			<div className="settings-head">
				<span>{t("命令行字号（终端）", "Command-line font size (terminal)")}</span>
				<span className="settings-sub">
					{t(
						"右侧终端面板里的字（也能在终端里用 ⌘/Ctrl + 滚轮调）",
						"Text inside the terminal panel (or ⌘/Ctrl + wheel in it)",
					)}
				</span>
			</div>
			<div className="settings-font-slider">
				<span className="settings-font-label">{t("字号", "Size")}</span>
				<div className="settings-font-track">
					<input
						id="settings-terminal-font"
						type="range"
						min={TERMINAL_FONT_MIN}
						max={TERMINAL_FONT_MAX}
						step={1}
						value={px}
						aria-label={t(
							`命令行字号（${TERMINAL_FONT_MIN}–${TERMINAL_FONT_MAX} 像素）`,
							`Command-line font size (${TERMINAL_FONT_MIN}–${TERMINAL_FONT_MAX} px)`,
						)}
						aria-valuetext={`${px}px`}
						onChange={(event) => setPx(Number(event.target.value))}
					/>
					<div className="settings-font-bounds" aria-hidden="true">
						<span>{TERMINAL_FONT_MIN}px</span>
						<span>{TERMINAL_FONT_MAX}px</span>
					</div>
				</div>
				<span className="settings-font-value mono">{px}px</span>
			</div>
			<div className="settings-hint">
				{t(
					"只存本机，立即生效。终端里 ⌘/Ctrl + 滚轮、⌘/Ctrl + = / - 也能调，⌘/Ctrl + 0 恢复 14px。",
					"Stored on this device and applied immediately. You can also use ⌘/Ctrl + wheel or ⌘/Ctrl + = / - inside the terminal; ⌘/Ctrl + 0 resets to 14px.",
				)}
			</div>
		</div>
	);
}

function AppearanceSettings() {
	const t = useT();
	const { font, width, setFont, setWidth } = useChatDisplay();
	// 侧栏项目名 / 会话名的大小：跟聊天字号同一套档位、同样立刻生效（侧栏就在旁边，看得见）
	const sidebarFonts = useSidebarFonts();
	return (
		<>
			{/* 顶栏名称排第一：它是这个 tab 里唯一「改了就马上在顶栏上看得见」的一项，
			     比字号 / 宽度更像是"外观"的开头（后两个是读对话时才在意的） */}
			<BrandSettings />
			{/* 紧跟着「顶栏高度」：同样改完顶栏立刻变，改的就是上面那一项所在的那条栏 */}
			<div className="settings-panel">
				<div className="settings-head">
					<span>{t("顶栏高度", "Top bar size")}</span>
					<span className="settings-sub">
						{t(
							"整条顶栏连同里面的按钮 / 图标一起缩放（100% = 标准大小，也就是默认值）",
							"Scales the whole top bar, its buttons and icons (100% = the standard size, also the default)",
						)}
					</span>
				</div>
				<AppbarScaleControl />
			</div>
			{/* 三处字号并排：聊天正文 → 侧栏项目名 → 侧栏会话名。
			    都是「字多大」这一类，放一起才不用在 tab 里来回找；同一套档位卡片。 */}
			{/* 终端字号排在三处字号**前面**（用户 2026-10-30：「在聊天字体大小上面加一个」）：
			 * 它调的是右侧终端面板（xterm）的字，跟下面三处一样都是「字多大」这一类，只是管的地方不同。 */}
			<TerminalFontSettings />
			<div className="settings-panel">
				<div className="settings-head">
					<span>{t("聊天字体大小", "Chat font size")}</span>
					<span className="settings-sub">
						{t("只影响对话正文（代码块、表格跟着缩放）", "Affects message text only (code and tables scale with it)")}
					</span>
				</div>
				<FontSizeControl name="settings-chat-font" layer="chat" value={font} onChange={setFont} />
			</div>
			{/* 图片宽度紧跟在字号后面：都是「读对话时的画面大小」，跟字号是一类 */}
			<ChatImageSettings />
			<div className="settings-panel">
				<div className="settings-head">
					<span>{t("侧栏项目名大小", "Sidebar project name size")}</span>
					<span className="settings-sub">
						{t("项目列表里那一行文件夹名", "The folder name rows in the project list")}
					</span>
				</div>
				<FontSizeControl
					name="settings-side-project-font"
					layer="project"
					value={sidebarFonts.project}
					onChange={sidebarFonts.setProject}
				/>
			</div>
			<div className="settings-panel">
				<div className="settings-head">
					<span>{t("侧栏会话名大小", "Sidebar session name size")}</span>
					<span className="settings-sub">
						{t(
							"会话标题；时间、置顶项目名等跟着按比例缩",
							"Session titles; timestamps and the pinned project label scale with them",
						)}
					</span>
				</div>
				<FontSizeControl
					name="settings-side-session-font"
					layer="session"
					value={sidebarFonts.session}
					onChange={sidebarFonts.setSession}
				/>
			</div>
			<div className="settings-panel">
				<div className="settings-head">
					<span>{t("聊天内容宽度", "Chat content width")}</span>
					<span className="settings-sub">
						{t("对话列的最大宽度（窄屏自动铺满）", "Max width of the conversation column (narrow screens fill it)")}
					</span>
				</div>
				<ChatWidthControl value={width} onChange={setWidth} />
			</div>
			{/* 色板不在这里了：2026-10-29 用户要求单独一页「主题」（见下面的 ThemeSettings）。
			 * 这一页只管“字多大 / 多宽 / 顶栏多高”这类尺寸。 */}
			<div className="settings-hint">
				{t(
					"点一下立即生效，不用保存。选择存在本机（localStorage），刷新后保持，不影响服务端和其它设备；首次是标准字号 + 满宽。",
					"Takes effect immediately, nothing to save. Stored on this machine (localStorage); it survives reloads and does not touch the server or other devices. The first run uses the standard size and full width.",
				)}
			</div>
		</>
	);
}

/**
 * 主题：6 套色板，按浅色 / 深色分两组卡片（从「外观」拆出来的一页）。
 *
 * 2026-10-29 用户：「这块移出来，在设置里加一个叫主题的」。
 * 拆的理由：配色跟字号 / 内容宽度 / 顶栏高度是两种心思 —— 一个是“整个界面什么颜色”，
 * 一个是“字多大、多宽”，挤在一页里得滚很久才看到色卡，而色卡是开着窗口边点边看的东西。
 *
 * 点一下就换，不用保存：跟字号同一套“本机偏好 + 立即生效”的做法（`use-theme.ts` 写 localStorage）。
 */
function ThemeSettings() {
	const t = useT();
	const { theme, setTheme } = useTheme();
	// 主题名与它那句说明来自 theme.ts（专有名词，不翻）；分组名与底部说明要翻
	const groups = [
		{ mode: "light" as const, label: t("浅色", "Light"), hint: t("白天 / 亮环境", "Daylight / bright rooms") },
		{ mode: "dark" as const, label: t("深色", "Dark"), hint: t("夜里 / 暗环境", "Night / dim rooms") },
	];
	return (
		<>
			{groups.map((group) => (
				<div className="settings-panel" key={group.mode}>
					<div className="settings-head">
						<span>{group.label}</span>
						<span className="settings-sub">{group.hint}</span>
					</div>
					<div className="theme-grid">
						{THEMES.filter((item) => modeOf(item.id) === group.mode).map((item) => (
							<ThemeCard key={item.id} theme={item} active={theme.id === item.id} onPick={() => setTheme(item.id)} />
						))}
					</div>
				</div>
			))}
			<div className="settings-hint">
				{t(
					"点一下立即生效，不用保存。选择存在本机（localStorage），刷新后保持，不影响服务端和其它设备；首次使用是「清亮白」。",
					"Takes effect immediately, nothing to save. Stored on this machine (localStorage); it survives reloads and does not touch the server or other devices. The first run uses the bright default theme.",
				)}
			</div>
		</>
	);
}
