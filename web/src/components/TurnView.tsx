import { memo, type ReactNode } from "react";
import type { ThreadItem, Turn } from "@shared/codex-ts/v2";
import type { TurnPlanState } from "../lib/codex-types";
import { ThreadItemView } from "./items";
import { PlanCard } from "./items/MiscItems";
import { DiffView } from "./DiffView";
import { Disclosure } from "./Disclosure";
import { IconAlert, IconGitBranch, IconLayers } from "./Icons";
import { formatDuration, relativeTime } from "../lib/format";

interface TurnViewProps {
	turn: Turn;
	plan?: TurnPlanState;
	diff?: string;
	streaming: boolean;
}

const TOOL_CALL_TYPES = new Set([
	"commandExecution",
	"fileChange",
	"mcpToolCall",
	"dynamicToolCall",
	"collabAgentToolCall",
	"functionCallOutput",
	"webSearch",
	"imageView",
	"imageGeneration",
]);

function itemType(item: ThreadItem): string {
	return typeof (item as { type?: unknown }).type === "string" ? (item as { type: string }).type : "unknown";
}

function isMessageItem(item: ThreadItem): boolean {
	const type = itemType(item);
	return type === "userMessage" || type === "agentMessage";
}

function isToolCallItem(item: ThreadItem): boolean {
	return TOOL_CALL_TYPES.has(itemType(item));
}

function TurnViewImpl({ turn, plan, diff, streaming }: TurnViewProps): ReactNode {
	const items = Array.isArray(turn.items) ? turn.items : [];
	const status = turn.status ?? "inProgress";
	const hasDiff = typeof diff === "string" && diff.trim().length > 0;
	const showPlan = plan && plan.plan.length > 0;
	const messageCount = items.filter(isMessageItem).length;
	const toolCallCount = items.filter(isToolCallItem).length;
	const detailItems = items.filter((item) => !isMessageItem(item));
	const hasDetails = detailItems.length > 0;
	const details = hasDetails ? (
		<Disclosure
			key="turn-details"
			className="turn-details"
			defaultOpen={false}
			summary={
				<span className="turn-details-summary">
					<IconLayers size={14} />
					<span className="turn-details-label">处理详情</span>
					<span className="turn-details-count">· {messageCount} 条消息</span>
					<span className="turn-details-count">· {toolCallCount} 次工具调用</span>
				</span>
			}
		>
			<div className="turn-details-items">
				{detailItems.map((item) => (
					<ThreadItemView key={item.id} item={item} streaming={streaming && status === "inProgress"} />
				))}
			</div>
		</Disclosure>
	) : null;

	// Keep the visible conversation in timeline order. The single details block is
	// inserted where the first processing item occurred and contains every
	// reasoning/tool item from this turn.
	let detailsInserted = false;
	const renderedItems: ReactNode[] = [];
	for (const item of items) {
		if (!isMessageItem(item)) {
			if (!detailsInserted && details) {
				renderedItems.push(details);
				detailsInserted = true;
			}
			continue;
		}
		renderedItems.push(<ThreadItemView key={item.id} item={item} streaming={streaming && status === "inProgress"} />);
	}

	return (
		<div className={`turn turn-${status}`}>
			{/* While a turn is running, the live "Working (Ns • esc to interrupt)"
			    line at the end of the transcript represents it; no divider here. */}
			{status !== "inProgress" ? (
				<div className="turn-divider">
					<span className={`turn-status-dot ${status}`} />
					<span className="turn-meta">
						{status === "failed" ? "Failed" : status === "interrupted" ? "Interrupted" : "Done"}
						{typeof turn.durationMs === "number" ? ` · ${formatDuration(turn.durationMs)}` : ""}
						{turn.startedAt ? ` · ${relativeTime(turn.startedAt)}` : ""}
					</span>
				</div>
			) : null}

			{turn.error?.message ? (
				<div className="inline-error" role="alert">
					<IconAlert size={14} />
					<span>{turn.error.message}</span>
				</div>
			) : null}

			{showPlan ? <PlanCard plan={plan.plan} explanation={plan.explanation} /> : null}

			<div className="turn-items">
				{renderedItems}
				{items.length === 0 && status === "inProgress" ? (
					<div className="muted small pad">Waiting for output…</div>
				) : null}
			</div>

			{hasDiff ? (
				<Disclosure
					className="turn-diff"
					defaultOpen={false}
					summary={
						<span className="turn-diff-summary">
							<IconGitBranch size={13} /> Changes in this turn
						</span>
					}
				>
					<DiffView diff={diff ?? ""} />
				</Disclosure>
			) : null}
		</div>
	);
}

export const TurnView = memo(TurnViewImpl);
