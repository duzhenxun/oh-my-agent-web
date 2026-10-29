/**
 * 「浏览电脑里的文件 / 文件夹」：在**服务端所在的这台电脑**上弹出操作系统的原生选择框。
 *
 * 为什么要在服务端弹：浏览器拿不到本机绝对路径。`showDirectoryPicker()` 只回一个沙箱句柄
 * （`.name` 是目录名，不是路径），拿它当工作区是跑不起来的；`showOpenFilePicker()` 更连路径都没有。
 * 用户在网页里手打路径又太折磨。这个工作台本来就是「单用户 + 跑在自己机器上」，
 * 所以最直接的做法就是在宿主机上开一个原生对话框，把用户选中的绝对路径回传。
 *
 * 两个入口（同一个实现，只是弹哪种框）：
 *   - `POST /api/fs/pick-path` `{ kind: "file" | "dir" }` → 新建项目 / 输入框里的「@ → 文件和文件夹」
 *   - `POST /api/fs/pick-dir` → 老接口（新建项目对话框用），等价于 `kind: "dir"`
 *
 * 只认三种平台的原生方式，拿不到就**如实告诉前端 unsupported**（前端会退回内置目录浏览 /
 * 让用户直接写路径），绝不假装成功：
 *   - macOS：`osascript` 的 `choose file` / `choose folder`
 *   - Windows：PowerShell 的 `OpenFileDialog` / `FolderBrowserDialog`
 *   - Linux：`zenity`（GNOME）
 *
 * 注意：服务端如果跑在没有图形会话的地方（ssh / launchd 守护进程 / 容器），这里会失败 ——
 * 那时前端会自动降级，功能不会因此不可用。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Express } from "express";
import { normalizeWorkspacePath } from "../util/paths.js";

const exec = promisify(execFile);

/** 用户可能翻很久，给足时间；超时按「取消」处理（不把请求挂死） */
const PICK_TIMEOUT_MS = 180_000;

/** 弹哪种框：选文件 / 选目录（原生对话框只支持其中一种，前端因此给两个条目） */
type PickKind = "file" | "dir";

type PickPathResult =
	{ path: string } | { canceled: true } | { unsupported: true; message: string } | { error: string };

/** 同一条命令可能是「用户取消」，也可能是真的出错 —— 分开，别把失败说成取消 */
function isCancel(stderr: string, code: number | undefined): boolean {
	const text = stderr.toLowerCase();
	if (text.includes("user cancel") || text.includes("-128")) return true;
	// zenity / kdialog 取消时就是退出码 1（且没有别的输出）
	return code === 1 && text.trim() === "";
}

const APPLE_SCRIPT_DIR = [
	'tell application "System Events" to activate',
	'set chosen to choose folder with prompt "选择项目文件夹"',
	"return POSIX path of chosen",
].join("\n");

const APPLE_SCRIPT_FILE = [
	'tell application "System Events" to activate',
	'set chosen to choose file with prompt "选择文件"',
	"return POSIX path of chosen",
].join("\n");

const WINDOWS_SCRIPT_DIR = [
	"Add-Type -AssemblyName System.Windows.Forms",
	"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
	'$dialog.Description = "选择项目文件夹"',
	"if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath } else { exit 1 }",
].join("; ");

const WINDOWS_SCRIPT_FILE = [
	"Add-Type -AssemblyName System.Windows.Forms",
	"$dialog = New-Object System.Windows.Forms.OpenFileDialog",
	'$dialog.Title = "选择文件"',
	"$dialog.CheckFileExists = $true",
	"if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName } else { exit 1 }",
].join("; ");

/** 按平台挑一条能用的命令；一条都没有就返回 null（→ unsupported） */
function pickerCommand(kind: PickKind): { file: string; args: string[] } | null {
	const file = kind === "file";
	if (process.platform === "darwin") {
		return { file: "osascript", args: ["-e", file ? APPLE_SCRIPT_FILE : APPLE_SCRIPT_DIR] };
	}
	if (process.platform === "win32") {
		return {
			file: "powershell.exe",
			args: ["-NoProfile", "-STA", "-Command", file ? WINDOWS_SCRIPT_FILE : WINDOWS_SCRIPT_DIR],
		};
	}
	// Linux / 其它：zenity 没装时命令不存在会直接失败（→ 前端降级），不会挂住
	return file
		? { file: "zenity", args: ["--file-selection", "--title=选择文件"] }
		: { file: "zenity", args: ["--file-selection", "--directory", "--title=选择项目文件夹"] };
}

/** 同时只允许开一个原生框：两个框叠在一起用户会不知道哪个算数 */
let picking = false;

async function pickPath(kind: PickKind): Promise<PickPathResult> {
	const command = pickerCommand(kind);
	if (!command) return { unsupported: true, message: `这个平台（${process.platform}）没有可用的原生选择框` };
	if (picking) return { error: "已经有一个选择框开着了" };

	picking = true;
	try {
		const { stdout } = await exec(command.file, command.args, { timeout: PICK_TIMEOUT_MS });
		// macOS 的 `POSIX path of chosen` 回的是 `/a/b/`（目录带尾斜杠）。原样传下去会让会话的
		// workspace 与 pi 写进会话 header 的 cwd（`resolve()` 过）对不上，侧栏里同一个项目
		// 就变成两个组（用户报的「新建项目出来是两个」）。在出口就归一化。
		const path = normalizeWorkspacePath(stdout.trim());
		if (path === "") return { canceled: true };
		return { path };
	} catch (error) {
		const record = error as { code?: number | string; stderr?: string; message?: string };
		if (isCancel(record.stderr ?? "", typeof record.code === "number" ? record.code : undefined)) {
			return { canceled: true };
		}
		// 命令不存在 / 没有图形会话：如实说「这里开不出来」，前端会退回内置浏览
		const reason = record.stderr?.trim() || record.message || "未知原因";
		return { unsupported: true, message: `这台机器上开不出选择框：${reason}` };
	} finally {
		picking = false;
	}
}

/** 把结果翻译成 HTTP（两个入口共用同一套状态码） */
function respond(result: PickPathResult, response: import("express").Response): void {
	if ("error" in result) {
		response.status(409).json({ error: { code: "fs.pick_busy", message: result.error } });
		return;
	}
	response.json(result);
}

export function registerPickPathRoutes(app: Express): void {
	/** 统一入口：`{ kind: "file" | "dir" }`（不传按 file，因为「选单个文件」是更常见的用法） */
	app.post("/api/fs/pick-path", async (request, response) => {
		const raw = (request.body as { kind?: unknown } | undefined)?.kind;
		respond(await pickPath(raw === "dir" ? "dir" : "file"), response);
	});

	/** 老接口：新建项目对话框的「浏览电脑…」（只选目录），行为与以前一字不差 */
	app.post("/api/fs/pick-dir", async (_request, response) => {
		respond(await pickPath("dir"), response);
	});
}
