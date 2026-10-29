/**
 * 「模型目录」探针（dsh / opencode / claude 三个 ACP 引擎共用）。
 *
 * 为什么需要它：这三个引擎**只在 `session/new` / `session/resume` 的返回里**给出模型表
 * （opencode / dsh 是 `configOptions`，claude 是 `models`），没有会话就问不到。
 * 于是刚切到引擎、还没开会话时，模型下拉是空的 —— 界面上就是「模型未就绪」，
 * 用户以为功能坏了（实测复现：`prewarm` 只连上子进程，`listModels()` 回 0 条；
 * 建完会话立刻变成 219 / 3 / 5 条）。
 *
 * 做法：在**临时目录**里开一个一次性会话，把目录抄下来，然后立刻关掉并删掉：
 *   - 临时目录由 `isScratchCwd` 判定 → 这些探针会话不会进侧栏（三个引擎的清单都按这条过滤）；
 *   - 删掉是免得在引擎自己的历史里留一条空会话（claude 删 JSONL、opencode 有 `session delete`、
 *     dsh 删会话目录，各自见调用处）。
 *
 * 代价（如实记在这里，免得以后有人以为它是免费的）：
 *   - 每个引擎实例**只探一次**（`reloadModels` / `dispose` 会重置），不是每帧都建会话；
 *   - 时间：claude / dsh ~1s，opencode 的 `session/new` 要 4~6s（它自己启动就要扫配置），
 *     所以这一步放在切引擎的那条路径上（界面本来就在等），不放在发消息的路径上。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 探针目录前缀（`isScratchCwd` 判定 → 侧栏不显示这类目录） */
const PROBE_CWD_PREFIX = "agent-web-models-";

/** 在临时工作区里跑一段逻辑，跑完把目录删掉（失败也删） */
export async function withProbeCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await mkdtemp(join(tmpdir(), PROBE_CWD_PREFIX));
	try {
		return await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
	}
}
