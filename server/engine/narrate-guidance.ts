/**
 * 教模型「动手之前先说人话」。
 *
 * 为什么必须有：对话区里的「过程」容器默认是**折叠**的 —— 用户一眼只看到
 * 「1 段思考 1 次工具 过程 2 步」。模型要是连着调五个工具、一句正文都不写，
 * 用户全程不知道它在查什么、改什么、碰到什么问题，只能干等。
 *
 * 所以：每一步动作前先给一两句「我发现了什么 / 我准备做什么」，
 * 工具结果推翻计划时也说一句。界面侧同时有「正在运行 bash…」那行实时状态（见 LiveActivity），
 * 两者合起来才是「看得懂在跑什么」。
 *
 * 同样写得短：这段会在**每一次**请求里重复计费。
 */
export const NARRATE_GUIDANCE = [
	"## Narrate before acting",
	"The user watches this conversation live, and tool cards are collapsed by default — they only see",
	'"1 thinking segment, 1 tool call" unless you write prose. So:',
	"- Before the first tool call of a task, write 1-2 sentences: what you found and what you are about to do.",
	"- Before modifying, writing or deleting files, say which files and why (1-2 sentences), then call the tools.",
	"- When a tool result changes your plan (failure, unexpected output, a discovery), say what it means before the next call.",
	"- Keep it short and in the user's language; never paste tool arguments back as prose.",
].join("\n");
