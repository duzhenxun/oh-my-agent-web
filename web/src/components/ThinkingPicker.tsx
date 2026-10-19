import { setThinkingLevel } from "../ws.ts";

/** 档位的中文标签（pi 的档位是英文，界面按用户习惯显示中文） */
const LABELS: Record<string, string> = {
	off: "关",
	minimal: "最低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最高",
};

/**
 * 思考强度选择器（P4）：只有模型支持推理时才出现（档位列表为空就整个不渲染）。
 * ⚡ + 当前档位的短标签 + ▾，点开是完整列表。
 */
export function ThinkingPicker({ level, levels }: { level: string | null; levels: string[] }) {
	if (levels.length === 0) return null;
	const current = level ?? levels[0] ?? "";
	return (
		<label className="tool-chip thinking-picker" title="思考强度（越高的档位越慢，推理也更细）">
			<span aria-hidden="true">⚡</span>
			<select className="thinking-select" value={current} onChange={(event) => setThinkingLevel(event.target.value)}>
				{levels.map((item) => (
					<option key={item} value={item}>
						{LABELS[item] ?? item}
					</option>
				))}
			</select>
		</label>
	);
}
