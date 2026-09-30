import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Turn } from "@shared/codex-ts/v2";
import { useCodex } from "../lib/useCodex";
import { TurnView } from "./TurnView";
import { IconAlert, IconChevronDown, IconPlus, IconSparkles } from "./Icons";

interface ChatViewProps {
	onOpenSidebar?: () => void;
}

export function ChatView(_props: ChatViewProps): ReactNode {
	const { activeThread, turns, turnDiffs, turnPlans, streamingTurnId, startThread, errors, info } = useCodex();
	const scrollRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [showJump, setShowJump] = useState(false);

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		stick.current = distance < 120;
		setShowJump(distance >= 320);
	}, []);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (stick.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [turns]);

	useEffect(() => {
		// Jump to bottom when switching threads.
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
		stick.current = true;
		setShowJump(false);
	}, [activeThread?.id]);

	const jumpToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
		stick.current = true;
		setShowJump(false);
	}, []);

	const orderedTurns = useMemo(() => {
		const list = Array.isArray(turns) ? turns.slice() : [];
		// Keep server order, but make sure the active streaming turn is last.
		return list as Turn[];
	}, [turns]);

	const threadErrors = useMemo(
		() => (activeThread ? errors.filter((e) => e.threadId === activeThread.id || e.threadId == null) : errors),
		[errors, activeThread],
	);

	if (!activeThread) {
		return (
			<div className="chat" ref={scrollRef}>
				<div className="empty-state">
					<div className="empty-mark">
						<IconSparkles size={28} />
					</div>
					<h2>Oh My Agent Web</h2>
					<p className="muted">
						{info?.cwd ? (
							<>
								Start a new thread in <code>{info.cwd}</code> to begin.
							</>
						) : (
							"Start a new thread to begin."
						)}
					</p>
					<button className="btn primary" onClick={() => void startThread()}>
						<IconPlus size={15} /> New thread
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="chat-wrap">
			<div className="chat" ref={scrollRef} onScroll={onScroll}>
				{orderedTurns.length === 0 ? (
					<div className="empty-state compact">
						<IconSparkles size={22} />
						<p className="muted">This thread is empty. Send a message to get started.</p>
					</div>
				) : null}
				{orderedTurns.map((turn) => (
					<TurnView
						key={turn.id}
						turn={turn}
						plan={turnPlans[turn.id]}
						diff={turnDiffs[turn.id]}
						streaming={streamingTurnId === turn.id}
					/>
				))}

				{threadErrors.map((e) => (
					<div className="inline-error" role="alert" key={e.id}>
						<IconAlert size={14} />
						<span>
							{e.message}
							{e.willRetry ? " (retrying…)" : ""}
						</span>
					</div>
				))}
				<div className="chat-bottom-pad" />
			</div>
			{showJump ? (
				<button className="jump-bottom" onClick={jumpToBottom} aria-label="Scroll to latest">
					<IconChevronDown size={16} />
				</button>
			) : null}
		</div>
	);
}
