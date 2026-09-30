import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import type { UserInput } from "@shared/codex-ts/v2";
import { useCodex } from "../lib/useCodex";
import { basename, shortenProjectPath } from "../lib/format";
import { IconAt, IconImage, IconSend, IconStop, IconX } from "./Icons";

interface Mention {
	name: string;
	path: string;
}

interface QueuedMessage {
	text: string;
	extra: UserInput[];
}

const MENTION_RE = /(?:^|\s)@([^\s@]*)$/;

/* Composer sizing (px). Keep in sync with `.composer textarea` in styles.css. */
const AUTO_MAX_H = 200;

export function Composer(): ReactNode {
	const { activeThread, streamingTurnId, sendMessage, interrupt, startThread, searchFiles, settings, models, info } = useCodex();
	const [text, setText] = useState("");
	const [attachments, setAttachments] = useState<UserInput[]>([]);
	const [mentions, setMentions] = useState<Mention[]>([]);
	const [suggestions, setSuggestions] = useState<Mention[]>([]);
	const [suggestOpen, setSuggestOpen] = useState(false);
	const [suggestIndex, setSuggestIndex] = useState(0);
	const [query, setQuery] = useState<string | null>(null);
	const [queue, setQueue] = useState<QueuedMessage[]>([]);

	const taRef = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const searchSeq = useRef(0);

	const streaming = Boolean(streamingTurnId);

	// Footer status line (mode / effort / project), Codex-style. The model name
	// resolves through the catalog so we show "GPT-6-Luna" instead of the id.
	const statusModel = useMemo(() => {
		const id = settings.model ?? activeThread?.model ?? null;
		const hit = id ? models.find((m) => m.id === id) : undefined;
		return hit?.displayName?.trim() || hit?.id || id || "default";
	}, [settings.model, activeThread?.model, models]);
	const statusEffort = settings.effort ?? activeThread?.reasoningEffort ?? "";
	const statusProject = shortenProjectPath(settings.cwd || info?.cwd || "");

	/**
	 * Auto-grow: the textarea is one line tall until the text wraps, then it
	 * grows up to `AUTO_MAX_H` and scrolls. The Send button sits beside it in a
	 * centred flex row, so it never overlaps the text.
	 */
	useEffect(() => {
		const el = taRef.current;
		if (!el) return;
		// Reset first so the box can also SHRINK when lines are removed.
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, AUTO_MAX_H)}px`;
	}, [text]);

	// Fuzzy file search for @mentions (debounced).
	useEffect(() => {
		if (query == null || query.length === 0) {
			setSuggestions([]);
			setSuggestOpen(false);
			return;
		}
		const seq = ++searchSeq.current;
		const t = setTimeout(() => {
			searchFiles(query)
				.then((files) => {
					if (seq !== searchSeq.current) return;
					const mapped = files.slice(0, 8).map((f) => ({ name: f.fileName || basename(f.path), path: f.path }));
					setSuggestions(mapped);
					setSuggestOpen(mapped.length > 0);
					setSuggestIndex(0);
				})
				.catch(() => {
					if (seq !== searchSeq.current) return;
					setSuggestions([]);
					setSuggestOpen(false);
				});
		}, 180);
		return () => clearTimeout(t);
	}, [query, searchFiles]);

	// Flush queued messages once the running turn completes.
	useEffect(() => {
		if (streaming) return;
		if (queue.length === 0) return;
		const [next, ...rest] = queue;
		setQueue(rest);
		void sendMessage(next.text, { extra: next.extra });
	}, [streaming, queue, sendMessage]);

	const updateQueryFromText = useCallback((value: string, cursor: number | null) => {
		const upto = cursor == null ? value : value.slice(0, cursor);
		const m = MENTION_RE.exec(upto);
		setQuery(m ? m[1] : null);
	}, []);

	const applyMention = useCallback(
		(item: Mention) => {
			const el = taRef.current;
			const cursor = el?.selectionStart ?? text.length;
			const before = text.slice(0, cursor);
			const after = text.slice(cursor);
			const m = MENTION_RE.exec(before);
			if (m) {
				const start = before.length - m[1].length - 1; // include the '@'
				const next = `${before.slice(0, start)}@${item.name} ${after}`;
				setText(next);
			} else {
				setText(`${text}@${item.name} `);
			}
			setMentions((prev) => (prev.some((p) => p.path === item.path) ? prev : [...prev, item]));
			setSuggestOpen(false);
			setQuery(null);
			requestAnimationFrame(() => taRef.current?.focus());
		},
		[text],
	);

	const buildExtra = useCallback((): UserInput[] => {
		const mentionInputs: UserInput[] = mentions.map((m) => ({ type: "mention", name: m.name, path: m.path }) as UserInput);
		return [...mentionInputs, ...attachments];
	}, [mentions, attachments]);

	const clearComposer = useCallback(() => {
		setText("");
		setMentions([]);
		setAttachments([]);
		setSuggestOpen(false);
		setQuery(null);
	}, []);

	const submit = useCallback(async () => {
		const value = text.trim();
		if (!value && attachments.length === 0 && mentions.length === 0) return;
		const extra = buildExtra();
		const payloadText = value || "(see attachments)";
		if (streaming) {
			setQueue((q) => [...q, { text: payloadText, extra }]);
		} else {
			if (!activeThread) {
				const created = await startThread();
				if (!created) return;
			}
			await sendMessage(payloadText, { extra });
		}
		clearComposer();
	}, [text, attachments.length, mentions.length, buildExtra, streaming, activeThread, startThread, sendMessage, clearComposer]);

	const onKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (suggestOpen && suggestions.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setSuggestIndex((i) => (i + 1) % suggestions.length);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setSuggestIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
					return;
				}
				if (e.key === "Enter" || e.key === "Tab") {
					e.preventDefault();
					applyMention(suggestions[suggestIndex]);
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					setSuggestOpen(false);
					return;
				}
			}
			if (e.key === "Enter" && !e.shiftKey) {
				// IME-safe: don't submit while an input method is composing.
				const native = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
				if (composing.current || native.isComposing || native.keyCode === 229) return;
				e.preventDefault();
				void submit();
			}
		},
		[suggestOpen, suggestions, suggestIndex, applyMention, submit],
	);

	const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		const images: File[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) images.push(file);
			}
		}
		if (images.length === 0) return;
		e.preventDefault();
		for (const file of images) {
			const reader = new FileReader();
			reader.onload = () => {
				const url = typeof reader.result === "string" ? reader.result : "";
				if (url) setAttachments((prev) => [...prev, { type: "image", url } as UserInput]);
			};
			reader.readAsDataURL(file);
		}
	}, []);

	const mentionChips = useMemo(
		() =>
			mentions.map((m) => (
				<span className="attach-chip" key={m.path}>
					<IconAt size={12} />
					<span className="attach-name">{m.name}</span>
					<button
						className="chip-x"
						aria-label={`Remove mention ${m.name}`}
						onClick={() => setMentions((prev) => prev.filter((p) => p.path !== m.path))}
					>
						<IconX size={11} />
					</button>
				</span>
			)),
		[mentions],
	);

	const imageChips = useMemo(
		() =>
			attachments.map((a, i) => {
				const url = typeof (a as { url?: unknown }).url === "string" ? (a as { url: string }).url : "";
				return (
					<span className="attach-chip image" key={i} title="Pasted image">
						{url ? <img src={url} alt="" /> : <IconImage size={12} />}
						<button className="chip-x" aria-label="Remove image" onClick={() => setAttachments((prev) => prev.filter((_, k) => k !== i))}>
							<IconX size={11} />
						</button>
					</span>
				);
			}),
		[attachments],
	);

	return (
		<div className="composer-wrap">
			{queue.length > 0 ? (
				<div className="queue-bar">
					{queue.length} queued message{queue.length > 1 ? "s" : ""}
					<button className="chip-x" aria-label="Clear queue" onClick={() => setQueue([])}>
						<IconX size={11} />
					</button>
				</div>
			) : null}
			<div className="composer">
				{(mentionChips.length > 0 || imageChips.length > 0) && (
					<div className="attach-row">
						{mentionChips}
						{imageChips}
					</div>
				)}
				{/* Textarea and Send share one centred row: one line tall by default,
				    growing with the text. The button is a sibling, never an overlay. */}
				<div className="composer-row">
					<div className="composer-input">
						<textarea
							ref={taRef}
							value={text}
							rows={1}
							placeholder={activeThread ? "Message Codex…  (@ to reference files)" : "New thread…  (@ to reference files)"}
							onChange={(e) => {
								setText(e.target.value);
								updateQueryFromText(e.target.value, e.target.selectionStart);
							}}
							onKeyDown={onKeyDown}
							onPaste={onPaste}
							onCompositionStart={() => {
								composing.current = true;
							}}
							onCompositionEnd={() => {
								composing.current = false;
							}}
							onClick={(e) => updateQueryFromText(text, (e.target as HTMLTextAreaElement).selectionStart)}
							aria-label="Message input"
						/>
						{suggestOpen && suggestions.length > 0 ? (
							<div className="mention-menu" role="listbox" aria-label="File suggestions">
								{suggestions.map((s, i) => (
									<button
										key={s.path}
										role="option"
										aria-selected={i === suggestIndex}
										className={`mention-item${i === suggestIndex ? " active" : ""}`}
										onMouseEnter={() => setSuggestIndex(i)}
										onMouseDown={(e) => {
											e.preventDefault();
											applyMention(s);
										}}
									>
										<span className="mention-name">{s.name}</span>
										<span className="mention-path">{s.path}</span>
									</button>
								))}
							</div>
						) : null}
					</div>
					<div className="composer-actions">
						{streaming ? (
							<>
								<button className="btn danger" onClick={() => void interrupt()} aria-label="Stop run">
									<IconStop size={15} /> Stop
								</button>
								<button
									className="btn"
									onClick={() => void submit()}
									aria-label="Queue message"
									disabled={!text.trim() && attachments.length === 0}
								>
									Queue
								</button>
							</>
						) : (
							<button
								className="btn primary"
								onClick={() => void submit()}
								aria-label="Send message"
								disabled={!text.trim() && attachments.length === 0 && mentions.length === 0}
							>
								<IconSend size={15} /> Send
							</button>
						)}
					</div>
				</div>
			</div>
			<div className="composer-hint muted">
				<span>Enter to send · Shift+Enter for newline</span>
				{streaming ? <span className="running-hint">Codex is working — messages will be queued</span> : null}
			</div>
			<div className="composer-status">
				<span className="status-model">{statusModel}</span>
				{statusEffort ? <span className="status-effort">{statusEffort}</span> : null}
				{statusProject ? <span className="status-project">· {statusProject}</span> : null}
			</div>
		</div>
	);
}
