/**
 * 会话里的 `appearance` 工具（ADR-0050）：agent 在聊天里读 / 改外观字号。
 *
 * 用户的原话：「我在这个 agent 里面说的话，你就可以去操作设置；你也有接口查看当前设置了什么，
 * 我说改哪个之前你先看一下现在是多少，我说改成多少，你要报改成多少」——
 * 所以这个工具一定要**先读、改完报差值**，而不是闷头写一个值。
 *
 * 落点是宿主的客户端设置（`set_settings` 那条路），浏览器收到快照后自己应用，
 * 所以改完一两秒内就能看见字变大，不需要刷新。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import {
	APPEARANCE_LABEL,
	APPEARANCE_MAX_PX,
	APPEARANCE_MIN_PX,
	appearancePatchFromArgs,
	describeAppearance,
	describeAppearanceChange,
	type AppearancePort,
} from "../session/appearance.js";

type AppearanceToolOptions = {
	/** 惰性取端口：宿主先建运行时、后挂设置存储，建会话时两边都好了 */
	port: () => AppearancePort | null;
};

const DEFAULT_PX = 14;

type Failure = { content: Array<{ type: "text"; text: string }>; details: undefined; isError: true };
type Success = { content: Array<{ type: "text"; text: string }>; details: undefined };

function ok(text: string): Success {
	return { content: [{ type: "text", text }], details: undefined };
}

function failure(error: unknown): Failure {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: undefined,
		isError: true,
	};
}

export function makeAppearanceToolExtension(options: AppearanceToolOptions): InlineExtension {
	return {
		name: "oh-my-agent-web-appearance",
		hidden: true,
		factory: (pi) => {
			pi.registerTool(
				defineTool({
					name: "appearance",
					label: "appearance",
					description: [
						"Read and change this workspace's UI text sizes (chat body, sidebar project names, sidebar session names).",
						"The value is stored by the host and pushed back to the browser, so a change takes effect within a second — no reload needed.",
						"Actions:",
						"- `read`: show the current px for the three layers. Do this first when the user talks about text being too small / too large.",
						"- `set`: change one layer (`chat` / `project` / `session`) or `all`. Give `px` for an absolute target (e.g. 18) or `delta` for a relative nudge (e.g. 2 / -2).",
						"- `reset`: back to the default 14px on all three layers.",
						`Range: ${APPEARANCE_MIN_PX}–${APPEARANCE_MAX_PX}px, even values only (same ladder as the settings slider: 12 / 14 / 16 / 18).`,
					].join("\n"),
					promptSnippet: "Read or change UI text sizes (chat body, sidebar names)",
					promptGuidelines: [
						"When the user says text is too small/large or asks to change 「字号 / 字体大小 / 对话文字 / 侧栏项目名」, call `appearance` with action=read first, then action=set.",
						"Always report the change as `before → after px` per layer (e.g. 「聊天正文：14px → 18px」) — the tool result gives you the exact numbers, use them instead of inventing.",
						"「对话/聊天文字」= target chat; 「侧栏项目名」= project; 「侧栏会话名」= session; if the user means everything, use target=all.",
						"For vague requests (「大一点」「小一点」) use delta=2 / delta=-2 rather than picking a fixed number.",
						"Values are clamped to 2–30px even numbers by the host; if the result shows a different number than requested, tell the user the clamped value.",
					],
					executionMode: "parallel",
					parameters: Type.Object({
						action: Type.String({ description: "One of: read | set | reset. Default: read." }),
						target: Type.Optional(
							Type.String({
								description:
									"`chat` (chat body) | `project` (sidebar project names) | `session` (sidebar session names) | `all`. Default: all.",
							}),
						),
						px: Type.Optional(
							Type.Number({
								description: `Absolute target size in px (${APPEARANCE_MIN_PX}–${APPEARANCE_MAX_PX}, even).`,
							}),
						),
						delta: Type.Optional(Type.Number({ description: "Relative change in px, e.g. 2 or -2." })),
					}),
					async execute(_toolCallId, params) {
						const port = options.port();
						if (!port) return failure(new Error("外观设置服务还没就绪，稍后再试"));
						const action = (typeof params.action === "string" ? params.action.trim().toLowerCase() : "") || "read";
						try {
							if (action === "read") return ok(describeAppearance(port.read()));
							const before = port.read();
							if (action === "reset") {
								const after = await port.set({
									chatPx: DEFAULT_PX,
									projectPx: DEFAULT_PX,
									sessionPx: DEFAULT_PX,
								});
								return ok([describeAppearanceChange(before, after), "", "已恢复默认 14px。"].join("\n"));
							}
							if (action !== "set") return failure(new Error(`未知 action：${action}（可用：read / set / reset）`));
							const parsed = appearancePatchFromArgs(params, before);
							if ("error" in parsed) return failure(new Error(parsed.error));
							const after = await port.set(parsed.patch);
							const touched = Object.keys(parsed.patch)
								.map((key) => APPEARANCE_LABEL[key as keyof typeof APPEARANCE_LABEL])
								.join("、");
							return ok(
								[
									`已改 ${touched}：`,
									describeAppearanceChange(before, after),
									"",
									"（浏览器会自动应用，通常 1 秒内就能看到。）",
								].join("\n"),
							);
						} catch (error) {
							return failure(error);
						}
					},
				}),
			);
		},
	};
}
