// Small formatting helpers used across the UI.
// All helpers are defensive: codex payloads are experimental and may change.

/** codex timestamps are usually Unix seconds; notification timestamps are ms. */
export function toMillis(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	// Anything below ~2001-09-09 in ms is almost certainly seconds.
	return value < 1e12 ? value * 1000 : value;
}

export function relativeTime(value: number | null | undefined): string {
	const ms = toMillis(value);
	if (ms == null) return "";
	const diff = Date.now() - ms;
	const future = diff < 0;
	const abs = Math.abs(diff);
	const sec = Math.round(abs / 1000);
	const min = Math.round(sec / 60);
	const hr = Math.round(min / 60);
	const day = Math.round(hr / 24);
	let text: string;
	if (sec < 45) text = future ? "in a moment" : "just now";
	else if (min < 60) text = `${min}m`;
	else if (hr < 24) text = `${hr}h`;
	else if (day < 30) text = `${day}d`;
	else if (day < 365) text = `${Math.round(day / 30)}mo`;
	else text = `${Math.round(day / 365)}y`;
	if (text === "just now" || text === "in a moment") return text;
	return future ? `in ${text}` : `${text} ago`;
}

export function formatClock(value: number | null | undefined): string {
	const ms = toMillis(value);
	if (ms == null) return "";
	const d = new Date(ms);
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDuration(ms: number | null | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	if (m < 60) return `${m}m ${rem}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

/**
 * Elapsed seconds as a live "timer" label: `4s`, `1m 05s`, `1h 12m`.
 * Unlike `formatDuration` it never shows sub-second precision.
 */
export function formatElapsedSeconds(sec: number | null | undefined): string {
	if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "";
	const total = Math.floor(sec);
	if (total < 60) return `${total}s`;
	const m = Math.floor(total / 60);
	const s = total % 60;
	if (m < 60) return `${m}m ${s}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatBytes(bytes: number | null | undefined): string {
	if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatTokens(n: number | null | undefined): string {
	if (typeof n !== "number" || !Number.isFinite(n)) return "0";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** basename for both POSIX and Windows-ish paths, tolerant of trailing slash. */
export function basename(path: string | null | undefined): string {
	if (!path) return "";
	const trimmed = path.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/);
	return parts[parts.length - 1] || trimmed;
}

export function dirname(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx <= 0 ? path : path.slice(0, idx);
}

/** Compact a path relative to cwd (or ~ for home), keeping the tail readable. */
export function shortenPath(path: string | null | undefined, cwd?: string | null, max = 48): string {
	if (!path) return "";
	let out = path;
	if (cwd && path.startsWith(cwd.replace(/\/$/, "") + "/")) {
		out = path.slice(cwd.replace(/\/$/, "").length + 1);
	} else {
		out = out.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
	}
	if (out.length > max) {
		const parts = out.split(/[\\/]/);
		out = "…/" + parts.slice(-2).join("/");
	}
	return out;
}

export function firstLine(text: string | null | undefined, max = 90): string {
	if (!text) return "";
	const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	const trimmed = line.trim();
	return trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed;
}

export function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

export function pluralize(n: number, one: string, many?: string): string {
	return `${n} ${n === 1 ? one : (many ?? one + "s")}`;
}

/**
 * Compact label for a workspace path, like `…a/ai/oh-my-agent-web`.
 *
 * Unlike `shortenPath` this never returns `.` for the current directory — a
 * project chip always has to name the project — and it keeps the tail segments
 * (the informative end) rather than the head.
 */
export function shortenProjectPath(path: string | null | undefined, max = 26): string {
	if (!path) return "";
	const home = path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
	if (home.length <= max) return home;
	const parts = home.replace(/\/+$/, "").split(/[\\/]/);
	let out = parts[parts.length - 1] ?? home;
	for (let i = parts.length - 2; i >= 0; i -= 1) {
		const next = `${parts[i]}/${out}`;
		if (next.length + 1 > max) break;
		out = next;
	}
	return out === home ? home : `…/${out}`;
}
