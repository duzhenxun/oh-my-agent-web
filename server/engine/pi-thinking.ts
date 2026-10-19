/**
 * 思考强度（P4）——从 pi-sdk.ts 抽出来（400 行护栏）。
 *
 * 档位与 pi-ai 的 ThinkingLevelSchema 对齐；这个常量没对外导出，所以写死并在此注明。
 * 模型不支持推理（model.reasoning !== true）时不提供档位 → 界面隐藏控件。
 */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

type SessionLike = {
	model?: { reasoning?: boolean };
	thinkingLevel?: string;
	setThinkingLevel?: (level: string) => void;
};

export function createPiThinking(sessions: Map<string, { session: unknown }>) {
	const pick = (sessionId?: string): SessionLike | undefined =>
		(sessionId ? sessions.get(sessionId) : [...sessions.values()].at(-1))?.session as SessionLike | undefined;

	return {
		async listThinkingLevels(sessionId?: string): Promise<string[]> {
			const session = pick(sessionId);
			if (!session?.model?.reasoning) return [];
			return [...THINKING_LEVELS];
		},

		async getThinkingLevel(sessionId?: string): Promise<string | null> {
			const level = pick(sessionId)?.thinkingLevel;
			return typeof level === "string" ? level : null;
		},

		async setThinkingLevel(sessionId: string, level: string): Promise<boolean> {
			const session = pick(sessionId);
			if (!session?.setThinkingLevel) return false;
			try {
				session.setThinkingLevel(level);
				return session.thinkingLevel === level;
			} catch {
				return false;
			}
		},
	};
}
