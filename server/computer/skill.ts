/**
 * 电脑控制的 Skill：启用时写入 `~/.agents/skills/agent-computer/SKILL.md`，禁用时改名为 `.SKILL.md.disabled`。
 *
 * 「启用」这件事只看这个文件是否存在，不另存状态文件（与 skill-store.ts 的启停约定一致）。
 * 为什么是 Skill 而不是 MCP：所有能用 bash 的引擎都能调用同一个 CLI，不用逐个改各家的 MCP 配置。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSkillsDir } from "../skills/skill-store.js";

export const SKILL_ID = "agent-computer";
const SKILL_FILE = "SKILL.md";
const SKILL_FILE_DISABLED = ".SKILL.md.disabled";
/** 写在 SKILL.md 第二行：只有带这个标记的文件才归我们管，别人手写的同名技能不覆盖 */
const MANAGED_MARKER = "<!-- managed-by: oh-my-agent-web agent-computer -->";

export function skillDir(): string {
	return join(defaultSkillsDir(), SKILL_ID);
}

/** 生成 CLI 的命令前缀：编译后用 node 直接跑 cli.js；开发环境（.ts）用 tsx */
export function cliCommand(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const compiled = join(here, "cli.js");
	if (existsSync(compiled)) return `node ${shellQuote(compiled)}`;
	return `node --import tsx ${shellQuote(join(here, "cli.ts"))}`;
}

function shellQuote(text: string): string {
	return /^[A-Za-z0-9_/.:@-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

export function skillEnabled(): boolean {
	return existsSync(join(skillDir(), SKILL_FILE));
}

/** 写入（或更新）SKILL.md。若已存在一个不是我们写的同名文件，直接报错，不覆盖。 */
export function enableSkill(cli: string = cliCommand()): void {
	const dir = skillDir();
	const file = join(dir, SKILL_FILE);
	if (existsSync(file)) {
		const current = readFileSync(file, "utf8");
		if (!current.includes(MANAGED_MARKER)) {
			throw new Error(`${file} 已存在且不是本应用写入的，请先改名或删除它再启用`);
		}
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, renderSkill(cli), "utf8");
	rmSync(join(dir, SKILL_FILE_DISABLED), { force: true });
}

/** 禁用：改名为 `.SKILL.md.disabled`，技能扫描就看不见了；文件内容保留，随时可以恢复。 */
export function disableSkill(): void {
	const dir = skillDir();
	const file = join(dir, SKILL_FILE);
	if (!existsSync(file)) return;
	const current = readFileSync(file, "utf8");
	if (!current.includes(MANAGED_MARKER)) return; // 不是我们的文件，不动它
	renameSync(file, join(dir, SKILL_FILE_DISABLED));
}

export function renderSkill(cli: string): string {
	return SKILL_TEMPLATE.replaceAll("{{CLI}}", cli);
}

const SKILL_TEMPLATE = [
	"---",
	"name: agent-computer",
	"description: 电脑控制（computer control）——替用户在本机 macOS 应用里动手操作（读取编号元素树与截图、点击、输入、按快捷键、滚动拖拽、执行菜单命令、等待界面变化）。触发词，任一命中就应当使用：电脑控制、电脑操作、操控电脑、操作电脑、操作桌面、桌面自动化、帮我操作电脑、帮我在电脑上、帮我点、帮我点一下、点这个按钮、点一下这里、帮我打开某个软件并完成步骤、帮我在这个 App 里填写、帮我提交、帮我发消息、帮我发文件、帮我导出、帮我保存、模拟鼠标键盘、自动点击、自动填写、帮我走一遍流程。Use when 用户要求你替他在真实的应用界面里执行动作（而不是写代码或查资料），或直接说「电脑控制」这类话。仅 macOS，需要本机 helper 在运行且已授予辅助功能与屏幕录制权限。",
	"---",
	"",
	MANAGED_MARKER,
	"",
	"# 电脑控制",
	"",
	"通过本机的 Agent Computer helper 操作桌面应用。所有命令都在 bash 里执行，输出是 JSON。",
	"",
	"```bash",
	"{{CLI}} <命令> [参数]",
	"```",
	"",
	"## 标准流程",
	"",
	"1. `{{CLI}} status`：确认 `running` 为 true，且 `accessibility`、`screenRecording` 都为 true。不满足时告诉用户到「设置 → 电脑控制」处理，不要自己绕过。",
	"2. `{{CLI}} apps`：列出可操作的应用，记下目标应用的名字。",
	'3. `{{CLI}} observe <应用>`：返回 `result.text`（带编号的界面元素，如 `#12 button "保存"`）和 `result.screenshot.path`（截图文件，用 read 工具打开可以看图）。',
	'4. 按编号操作：`click <应用> --element 12`，`type <应用> "文字" --element 5`，`keys <应用> cmd+s`。',
	"5. 每次改变界面的操作之后，用 `wait` 或再 `observe` 确认结果，再做下一步。不要连续盲点。",
	"6. 任务结束后执行 `{{CLI}} finish`。",
	"",
	"## 微信发消息（Mac 版，优先用这个流程）",
	"",
	"用户说「给某人发微信 / 发消息」时，默认走电脑版微信，不用手机。流程要快：找到人后不截图确认，不问用户「要不要发」。",
	"",
	"1. 激活：`osascript -e 'tell application \"WeChat\" to activate'`。",
	"2. 搜索：`{{CLI}} keys 微信 cmd+f`，再 `{{CLI}} paste 微信 \"姓名\" --format text` 粘贴姓名。不要用 `type` 输入中文，不生效。",
	"3. 回车：`{{CLI}} keys 微信 Return`。会打开最靠上的精确匹配会话，光标自动落在输入框里。",
	"4. 粘贴文案：`{{CLI}} paste 微信 \"文案\" --format text`。",
	"5. 回车发送：`{{CLI}} keys 微信 Return`。",
	"6. 只在第 1 步之后截图一次，确认会话标题对得上；发送后截图确认气泡出现即可。",
	"",
	"注意：微信界面树里没有搜索框和输入框的编号元素，不要用 `click --x/--y` 去点，实测坐标会点偏。名字有歧义（多个近似联系人）时停下来让用户选；用户明确要求发送时才执行第 4、5 步。",
	"",
	"## 命令速查",
	"",
	"| 命令 | 作用 |",
	"|---|---|",
	"| `status` | helper 是否运行、权限是否授予 |",
	"| `access [--request]` | 查看权限；加 `--request` 才会弹出系统授权提示（先问过用户再加） |",
	"| `apps` | 列出应用（运行中的排前面） |",
	"| `observe <应用> [--full]` | 读取界面树 + 截图；`--full` 返回完整树 |",
	"| `click <应用> --element N [--button left\\|right] [--times 2]` | 按编号点击 |",
	"| `click <应用> --x X --y Y` | 按截图像素坐标点击（只在没有编号时用） |",
	'| `type <应用> "文字" [--element N]` | 输入文字（优先走无障碍接口） |',
	"| `keys <应用> <组合键>` | 按键，如 `cmd+s`、`Return`、`ctrl+shift+Tab` |",
	'| `fill <应用> --element N --value "值"` | 直接替换输入框内容 |',
	'| `paste <应用> "文本" [--format text\\|markdown\\|html]` | 粘贴（会临时占用剪贴板，之后恢复） |',
	"| `scroll <应用> up\\|down\\|left\\|right [--element N] [--pages 2]` | 滚动 |",
	"| `drag <应用> --from X,Y --to X,Y` | 拖拽（截图像素坐标） |",
	'| `invoke <应用> --element N --name "按下"` | 执行元素的无障碍动作 |',
	"| `commands <应用> [--query 保存]` | 列出应用菜单命令（带快捷键） |",
	'| `run-command <应用> "文件 ▸ 存储"` | 直接执行菜单命令，不用逐级打开菜单 |',
	"| `wait <应用> --until X [--text T] [--element N] [--timeout 10]` | 等待：`text_appears`、`text_gone`、`element_changes`、`new_window`、`settled`、`any_change` |",
	"| `preview on\\|off` | 显示或隐藏 helper 的实时预览浮窗 |",
	"| `finish` | 结束本次操作会话 |",
	"",
	"## 规则",
	"",
	"- **不要输入密码。** 遇到密码框 helper 会拒绝输入，请让用户自己在界面里输入。",
	"- **涉及发送消息、付款、删除、提交订单等不可撤销的动作，先向用户确认再点。**",
	"- 应用正在被用户操作（错误 `userActive` / `userTookOver`）时，等几秒再试，或告诉用户你需要他先放开鼠标键盘。",
	"- 错误 JSON 里的 `retryable` 为 true 才可以重试；为 false 时直接把原因告诉用户。",
	"- `timedOut` 出现在操作（click、type 等）上时，操作可能已经执行过，先 `observe` 确认，不要直接重复执行。",
	"- 截图和界面树只描述当时的状态，操作后请重新读取再决定下一步。",
	"",
].join("\n");
