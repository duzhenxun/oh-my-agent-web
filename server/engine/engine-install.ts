/**
 * 引擎安装器 —— **只有用户在界面上点了「安装」才会跑**（ADR-0052）。
 *
 * 三件事决定这份代码长这样：
 *
 * 1. **装到哪**：`<dataDir>`（默认 `~/.oh-my-agent-web`）这个 npm prefix —— 与
 *    `scripts/install.sh` 完全同一个位置。不用 `npm i -g` 进系统目录：那边常常要 sudo，
 *    还会被 Homebrew / nvm 的 prefix 抢走。这个 prefix 里 `bin/` + `lib/node_modules/`
 *    是标准 npm 布局，用户想自己 `npm ls -g --prefix ~/.oh-my-agent-web` 看一眼都行。
 *
 * 2. **谁来跑 npm**：找 `PATH` 里的 npm（安装脚本或系统那份） ——
 *    找不到就直说，不去猜别的包管理器。
 *
 * 3. **装完怎么生效**：把 `<prefix>/bin` **追加**进 PATH（用户自己的同名命令仍然优先）。
 *    pi 例外：它是**模块**（进程内 SDK），当前进程已经加载过/加载失败了，装完必须重启才知道 ——
 *    所以 pi 的结果里 `restartRequired: true`，界面据此提示。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { appendToPath, pathSeparator } from "../util/path-env.js";
import { findExecutable, resolveCli } from "../util/spawn-cli.js";
import { ENGINE_SPECS, type AnyEngineKey } from "./engine-specs.js";

/** 安装目标就是工作台自己的 npm prefix（与 install.sh 一致） */
export function npmPrefix(dataDir: string): string {
	return dataDir;
}

/** npm 的 bin 目录：POSIX 是 `<prefix>/bin`，Windows 上可执行文件直接落在 `<prefix>` */
export function prefixBinDir(prefix: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? prefix : join(prefix, "bin");
}

/**
 * `npm install` 的参数。
 *
 * 注意**没有** `npm i -g` 那种「装进系统全局」的写法：`--global` 与 `--prefix` 一起用，
 * 才是「装成一个可全局调用的包，但落在我们指定的目录里」。
 */
export function npmInstallArgs(packages: string[], prefix: string): string[] {
	return ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel", "error", ...packages];
}

/**
 * pi 的模块路径（拿不到 = 这份工作台里没有 pi）。
 *
 * 为什么不查 PATH：pi 是以 **SDK 模块**被使用的（`pi-sdk.ts`），进程内跑；
 * 用户装没装全局 `pi` 命令跟这里能不能用是两件事。
 */
export function piModulePath(): string | null {
	try {
		return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	} catch {
		return null;
	}
}

/**
 * 启动时把「上次点安装装好的 bin 目录」重新挂回 PATH。
 *
 * 为什么每次启动都要做：装包时我们只改了**当时那个进程**的 PATH。重启后不重新挂上，
 * 就会出现「明明装过了、界面还显示未安装」——最容易被当成安装失败的情况。
 * 只在这个目录真的存在时才挂（没装过的人 PATH 不该多出一条空目录）。
 */
export function ensurePrefixOnPath(
	dataDir: string,
	env: NodeJS.ProcessEnv = process.env,
	options: { platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {},
): string | null {
	const platform = options.platform ?? process.platform;
	const exists = options.exists ?? existsSync;
	const binDir = prefixBinDir(npmPrefix(dataDir), platform);
	if (!exists(binDir)) return null;
	const key = env.PATH !== undefined ? "PATH" : env.Path !== undefined ? "Path" : "PATH";
	env[key] = appendToPath(env[key], [binDir], platform);
	return binDir;
}

export type EngineStatus = {
	name: AnyEngineKey;
	label: string;
	/** 现在能不能用 */
	installed: boolean;
	/** 用的是什么（可执行文件路径 / pi 的模块路径）；没装为 null */
	path: string | null;
	/** 界面上给不给「安装」按钮（dsh 没有公开 npm 包 → 不给，只给去向） */
	installable: boolean;
	/** 用户不想点按钮时的自己动手版 */
	guide: string[];
	afterInstall?: string;
};

/**
 * 「这个引擎现在能不能用」—— 纯查询，不装、不改任何东西。
 *
 * 四种来源按优先级排：显式变量（`AGENT_WEB_*_BIN`）→ PATH → 我们自己的 prefix（上次点安装装的）。
 * pi 特殊：只认模块能否解析（`piModulePath`），因为它是进程内 SDK。
 */
export function engineStatus(
	engine: AnyEngineKey,
	options: {
		dataDir: string;
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
		exists?: (path: string) => boolean;
		find?: (bin: string, env: NodeJS.ProcessEnv) => string | null;
		piPath?: string | null;
	} = { dataDir: "" },
): EngineStatus {
	const spec = ENGINE_SPECS[engine];
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const base = {
		name: engine,
		label: spec.label,
		installable: spec.packages.length > 0,
		guide: spec.guide,
		...(spec.afterInstall ? { afterInstall: spec.afterInstall } : {}),
	};

	if (spec.inProcess) {
		const path = options.piPath === undefined ? piModulePath() : options.piPath;
		return { ...base, installed: path !== null, path };
	}

	const find =
		options.find ?? ((bin: string, e: NodeJS.ProcessEnv) => findExecutable(bin, e, platform, options.exists));
	const explicit = env[spec.binEnv]?.trim();
	if (explicit) return { ...base, installed: true, path: explicit };
	for (const bin of spec.bins) {
		const found = find(bin, env);
		if (found) return { ...base, installed: true, path: found };
	}
	// 上次点过安装：prefix 的 bin 里应该就有（PATH 是启动/安装时追加进去的）
	const binDir = prefixBinDir(npmPrefix(options.dataDir), platform);
	for (const bin of spec.bins) {
		const found = findExecutable(bin, { PATH: binDir, PATHEXT: env.PATHEXT }, platform, options.exists);
		if (found) return { ...base, installed: true, path: found };
	}
	return { ...base, installed: false, path: null };
}

export type InstallOutcome =
	| {
			ok: true;
			engine: AnyEngineKey;
			package: string;
			/** 装完之后可执行文件在哪（pi 是模块，这里是它的入口文件或 null） */
			path: string | null;
			/** 需要重启工作台才生效（pi 这种进程内模块） */
			restartRequired: boolean;
			message: string;
	  }
	| { ok: false; engine: AnyEngineKey; message: string };

/**
 * 装一个引擎（用户点了按钮才调）。
 *
 * `packages` 按顺序试：claude 的适配器改过名，新名可能还没发布 / 老名可能已废弃，
 * 一个装不上就换下一个 —— 但**全部失败就如实失败**，不吞错。
 */
export async function installEngine(
	engine: AnyEngineKey,
	options: {
		dataDir: string;
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
		log?: (line: string) => void;
	} = { dataDir: "" },
): Promise<InstallOutcome> {
	const spec = ENGINE_SPECS[engine];
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const log = options.log ?? (() => {});

	if (spec.packages.length === 0) {
		return {
			ok: false,
			engine,
			message: `${spec.label} 没有公开的 npm 包，工作台没法替你装：${spec.guide.join("；")}`,
		};
	}

	const prefix = npmPrefix(options.dataDir);
	const failures: string[] = [];
	for (const name of spec.packages) {
		const args = npmInstallArgs([`${name}@latest`], prefix);
		log(`安装 ${name}：npm ${args.join(" ")}`);
		const code = await new Promise<number>((resolve) => {
			// Windows 上 npm 是 npm.cmd：resolveCli 负责改成 cmd.exe /c（否则 EINVAL）
			const command = resolveCli("npm", args, env, platform);
			const child = spawn(command.file, command.args, { ...command.options, env, stdio: ["ignore", "pipe", "pipe"] });
			child.stdout?.on("data", (chunk: Buffer) => log(chunk.toString().trimEnd()));
			child.stderr?.on("data", (chunk: Buffer) => log(chunk.toString().trimEnd()));
			child.on("error", (error) => {
				failures.push(`${name}：${error.message}`);
				resolve(1);
			});
			child.on("exit", (exitCode) => resolve(exitCode ?? 1));
		});
		if (code !== 0) {
			failures.push(`${name}：npm 退出码 ${code}`);
			continue;
		}
		// 装好了：把 prefix 的 bin 追加进 PATH，同进程里马上就能被找到（pi 除外，见下）
		env.PATH = appendToPath(env.PATH ?? env.Path, [prefixBinDir(prefix, platform)], platform);
		const path = spec.inProcess ? piModulePath() : findInstalled(engine, env, prefix, platform);
		return {
			ok: true,
			engine,
			package: name,
			path,
			restartRequired: spec.inProcess === true,
			message: spec.inProcess ? `${spec.label} 已装好，重启工作台后生效` : `${spec.label} 已装好，切过去就能用`,
		};
	}

	return {
		ok: false,
		engine,
		message: `安装失败（网络 / 权限 / 包名不存在都可能）：${failures.join("；")}。也可以自己装：${spec.guide.join("；")}`,
	};
}

/** 装完之后去 prefix 的 bin 里确认真的有了（npm 成功不代表文件就在那 —— 版本太老时 bin 会落别处） */
function findInstalled(
	engine: AnyEngineKey,
	env: NodeJS.ProcessEnv,
	prefix: string,
	platform: NodeJS.Platform,
): string | null {
	const binDir = prefixBinDir(prefix, platform);
	const envWithPrefix: NodeJS.ProcessEnv = {
		...env,
		PATH: `${binDir}${pathSeparator(platform)}${env.PATH ?? env.Path ?? ""}`,
	};
	for (const bin of ENGINE_SPECS[engine].bins) {
		const found = findExecutable(bin, envWithPrefix, platform, existsSync);
		if (found) return found;
	}
	return null;
}
