import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { Thread } from "@shared/codex-ts/v2";
import { useCodex } from "../lib/useCodex";
import { basename, firstLine, relativeTime } from "../lib/format";
import { IconArchive, IconEdit, IconFork, IconMore, IconTerminal, IconTrash } from "./Icons";

function statusClass(thread: Thread): string {
	const t = (thread.status as { type?: string } | undefined)?.type ?? "idle";
	switch (t) {
		case "active":
			return "dot-active";
		case "systemError":
			return "dot-error";
		case "idle":
			return "dot-idle";
		default:
			return "dot-faint";
	}
}

function threadTitle(thread: Thread): string {
	if (thread.name && thread.name.trim()) return thread.name.trim();
	const preview = firstLine(thread.preview, 80);
	if (preview) return preview;
	return thread.id.slice(0, 12);
}

interface RowProps {
	thread: Thread;
	active: boolean;
	onOpen: (id: string) => void;
	onRename: (id: string, name: string) => void;
	onArchive: (id: string) => void;
	onDelete: (id: string) => void;
	onFork: (id: string) => void;
	onOpenSessionLogs: (id: string) => void;
	archivedView: boolean;
}

const ThreadRow = memo(function ThreadRow({
	thread,
	active,
	onOpen,
	onRename,
	onArchive,
	onDelete,
	onFork,
	onOpenSessionLogs,
	archivedView,
}: RowProps): ReactNode {
	const [menuOpen, setMenuOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(threadTitle(thread));
	const menuRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!menuOpen) return;
		const onDown = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setMenuOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [menuOpen]);

	useEffect(() => {
		if (editing) {
			setDraft(threadTitle(thread));
			requestAnimationFrame(() => inputRef.current?.select());
		}
	}, [editing, thread]);

	const commit = () => {
		const name = draft.trim();
		if (name && name !== threadTitle(thread)) onRename(thread.id, name);
		setEditing(false);
	};

	return (
		<div className={`thread-row${active ? " active" : ""}`}>
			{editing ? (
				<input
					ref={inputRef}
					className="thread-rename"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							commit();
						} else if (e.key === "Escape") {
							e.preventDefault();
							setEditing(false);
						}
					}}
				/>
			) : (
				<button className="thread-main" onClick={() => onOpen(thread.id)} title={threadTitle(thread)}>
					<span className={`status-dot ${statusClass(thread)}`} aria-hidden />
					<span className="thread-texts">
						<span className="thread-title">{threadTitle(thread)}</span>
						<span className="thread-sub">
							{basename(thread.cwd)}
							{thread.updatedAt ? ` · ${relativeTime(thread.updatedAt)}` : ""}
						</span>
					</span>
				</button>
			)}
			<div className="thread-menu-wrap" ref={menuRef}>
				<button
					className="icon-btn tiny thread-menu-btn"
					aria-label={`Actions for ${threadTitle(thread)}`}
					onClick={(e) => {
						e.stopPropagation();
						setMenuOpen((v) => !v);
					}}
				>
					<IconMore size={15} />
				</button>
				{menuOpen ? (
					<div className="menu" role="menu">
						<button role="menuitem" onClick={() => { setMenuOpen(false); setEditing(true); }}>
							<IconEdit size={14} /> Rename
						</button>
						<button role="menuitem" onClick={() => { setMenuOpen(false); onFork(thread.id); }}>
							<IconFork size={14} /> Fork
						</button>
						<button role="menuitem" onClick={() => { setMenuOpen(false); onOpenSessionLogs(thread.id); }}>
							<IconTerminal size={14} /> 实时日志
						</button>
						<button role="menuitem" onClick={() => { setMenuOpen(false); onArchive(thread.id); }}>
							<IconArchive size={14} /> {archivedView ? "Unarchive" : "Archive"}
						</button>
						<div className="menu-sep" />
						<button
							role="menuitem"
							className="danger"
							onClick={() => {
								setMenuOpen(false);
								if (window.confirm("Delete this thread permanently?")) onDelete(thread.id);
							}}
						>
							<IconTrash size={14} /> Delete
						</button>
					</div>
				) : null}
			</div>
		</div>
	);
});

export function ThreadList({ onOpenSessionLogs }: { onOpenSessionLogs: (threadId: string) => void }): ReactNode {
	const {
		threads,
		activeThread,
		openThread,
		renameThread,
		archiveThread,
		deleteThread,
		forkThread,
		threadsCursor,
		listThreads,
		threadsLoading,
		threadsError,
		archived,
		searchTerm: search,
	} = useCodex();

	// Debounced search -> thread/list searchTerm.
	//
	// The provider already lists threads when the socket opens, so the first effect
	// run must NOT fire a second one: it would race the socket and surface as
	// `WebSocket is not connected (rpc "thread/list")`.
	//
	// The guard is a *last applied query*, not a "did we run yet" boolean on
	// purpose — React StrictMode mounts effects twice in dev and refs survive that
	// remount, so a boolean would be consumed by the first pass and then fire
	// anyway on the second one.
	const lastQuery = useRef<{ search: string; archived: boolean } | null>(null);
	useEffect(() => {
		const prev = lastQuery.current;
		lastQuery.current = { search, archived };
		if (prev === null || (prev.search === search && prev.archived === archived)) return;
		const t = setTimeout(() => {
			void listThreads({ searchTerm: search, append: false, archived });
		}, search ? 280 : 0);
		return () => clearTimeout(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [search, archived]);

	if (threadsError) {
		return (
			<div className="thread-list">
				<div className="list-error">
					Couldn't load threads: {threadsError}
					<button className="btn ghost small" onClick={() => void listThreads({ append: false })}>
						Retry
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="thread-list">
			{threads.length === 0 && !threadsLoading ? (
				<div className="list-empty muted">{search ? "No matching threads" : "No threads yet"}</div>
			) : null}
			{threads.map((thread) => (
				<ThreadRow
					key={thread.id}
					thread={thread}
					active={activeThread?.id === thread.id}
					onOpen={(id) => void openThread(id)}
					onRename={(id, name) => void renameThread(id, name)}
					onArchive={(id) => void archiveThread(id, !archived)}
					onDelete={(id) => void deleteThread(id)}
					onFork={(id) => void forkThread(id)}
					onOpenSessionLogs={onOpenSessionLogs}
					archivedView={archived}
				/>
			))}
			{threadsCursor ? (
				<button
					className="btn ghost small load-more"
					disabled={threadsLoading}
					onClick={() => void listThreads({ append: true, cursor: threadsCursor })}
				>
					{threadsLoading ? "Loading…" : "Load more"}
				</button>
			) : null}
			{threads.length === 0 && threadsLoading ? <div className="list-empty muted">Loading…</div> : null}
		</div>
	);
}
