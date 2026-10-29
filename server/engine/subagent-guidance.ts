/**
 * 教模型「什么时候该派活给子代理」。
 *
 * 为什么需要单独一段：`Agent` 工具确实在里面，但**弱一些的模型不会主动用**——
 * 现象是用户说「并行看这几个目录」，它自己串行跑三遍 bash，然后说「我没有 spawn 能力」。
 * 工具描述模型经常只看一遍就忘，这段是每次请求都在的固定提示（所以写得很短）。
 *
 * 只在子代理**开启且有可用模板**时才拼进系统提示（见 pi-sdk 的 startSession）。
 */
export const SUBAGENT_GUIDANCE = [
	"## Delegating to subagents",
	"You have an `Agent` tool. Each subagent runs as a separate Pi session with its own context and",
	"a restricted tool set, and the user can watch or stop it in the workspace's Agents panel.",
	"- When a task splits into independent parts (several directories to inspect, several sources to",
	"  fetch, several files to review), issue one `Agent` call per part **in the same reply** so they",
	"  run in parallel, instead of doing each one yourself in sequence.",
	"- Delegate work that would flood your context (broad searches, long reads) and keep the",
	"  conclusion; do small, sequential or interdependent steps yourself.",
	"- Give every call a short `description` (it is the row title in the panel) and a self-contained",
	"  `prompt`; the subagent cannot see this conversation.",
	"- Never claim you cannot spawn subagents: if an `Agent` call fails, report the error it returned.",
].join("\n");
