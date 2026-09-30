# oh-my-agent-web

A browser cockpit for the [Codex CLI](https://github.com/openai/codex) `app-server`.
Chat, tool calls, diffs and approval dialogs in one tab.

The server is a **transparent JSON-RPC proxy + process supervisor**. It starts
`codex app-server` on boot, keeps it alive, and lets the browser invoke any
app-server method — while adding a few local `omaw/*` helpers.

```
browser  <--ws /ws-->  oh-my-agent-web server  <--ws-->  codex app-server (ws://127.0.0.1:25258)
```

## Install

The published package is **`oh-my-agent-web`**. It installs two equivalent
commands: **`oh-my-agent-web`** and the short alias **`omaw`**.

```bash
# global install
npm install -g oh-my-agent-web
npm install -g oh-my-agent-web@latest     # force the newest version

# or run without installing
npx oh-my-agent-web                       # start the UI
npx oh-my-agent-web ws                    # WS client (default ws://127.0.0.1:25258)
npx oh-my-agent-web ws --port 25258       # WS client on an explicit port
npx oh-my-agent-web ps                    # list processes and ports
```

After a global install, `oh-my-agent-web` and `omaw` are the same program:

```bash
omaw                                     # http://127.0.0.1:25257  (= oh-my-agent-web)
omaw ws                                  # interactive WS client
omaw ws --port 25259
omaw ps                                  # processes + ports
```

> Requires Node.js >= 22. If `npx oh-my-agent-web` fails to find the binary
> on your setup, use `npx -p oh-my-agent-web oh-my-agent-web ...` or a global
> install instead.

### Update notification

Every run of `oh-my-agent-web` (including the `ws` and `ps` subcommands) checks npm for
a newer version and prints a short notice when one exists:

```
  Update available: oh-my-agent-web 0.1.0 → 0.2.0
      npm install -g oh-my-agent-web@latest
      (disable this check with OMAW_NO_UPDATE_CHECK=1)
```

The check hits the registry at most once per 24h (result cached in
`~/.cache/oh-my-agent-web/update-check.json`), never blocks on errors, and is skipped
for `--help` / `--version` / `--json`.

| Env | Default | Meaning |
| --- | --- | --- |
| `OMAW_NO_UPDATE_CHECK` | *(unset)* | `1` disables the version check |
| `OMAW_UPDATE_CHECK_INTERVAL_MS` | `86400000` (24h) | Minimum gap between registry checks |

Also skipped automatically when `CI` or `NO_UPDATE_NOTIFIER` is set.

## Quick start (from source)

```bash
npm install
npm run build          # builds web/ (Vite) + server/ (tsc)
npm start              # http://127.0.0.1:25257
```

`npm start` boots the server, spawns `codex app-server --listen ws://127.0.0.1:25258`
(unless a healthy one is already running), and opens your browser. The app-server
is started as-is: by default oh-my-agent-web injects **no** `chatgpt_base_url` /
`model_providers.capture.base_url` overrides and runs no capture proxy. Set
`OMAW_REQUEST_INSPECTOR=1` to opt into the loopback request/response inspector
(which is what makes each session show live request/response logs).

## Development

```bash
npm run dev
```

Runs the backend (`tsx watch`, port **25257**) and mounts Vite **in the same
process** as middleware (`OMAW_DEV_WEB=1`). There is only one port and one entry
point — **http://127.0.0.1:25257** — which serves the live frontend source (with
HMR) and the `/ws` hub from the same origin. No build step, no second dev port.

Use `npm run build:web` (or `npm start`) when you want the static `web/dist`
bundle instead. The frontend lives in `web/`; backend in `server/`.

To iterate on the UI without spending model tokens, `web/dev-mock-server.mjs`
is a scripted stand-in for the backend that speaks the same protocol and
replays a recorded turn (reasoning, streamed message, command output, diff,
token usage, an approval request). It listens on `:25257/ws`, so the Vite proxy
picks it up with no config change. This is the one flow where the plain `vite`
CLI is the entry point (there is no backend to host it as middleware), so open
the URL Vite prints — `npm run dev:web`:

```bash
node web/dev-mock-server.mjs   # 代替 npm run dev（它只提供 :25257/ws）
npm run dev:web
```

Other useful scripts:

| Script                   | What it does                                          |
| ------------------------ | ----------------------------------------------------- |
| `npm run build:server`   | `tsc -p tsconfig.server.json` → `dist/`               |
| `npm run stop`           | Gracefully stops the service on `OMAW_PORT` (default 25257) |
| `npm run restart`        | Stops and starts the service again                    |
| `npm run typecheck`      | Typechecks server + web without emitting              |
| `npm run smoke`          | End-to-end smoke test against a real codex app-server |
| `npm run ws`             | WebSocket client for the app-server (see below) |
| `npm run omaw`            | Run from source: no args → dev stack on http://127.0.0.1:25257 (Vite in-process, no build) |
| `npm run omaw -- <args>`  | Run the CLI from source, e.g. `npm run omaw -- ps`, `npm run omaw -- ws -p 25259` |

## CLI

```
oh-my-agent-web [options]

  --port <n>          Port for the web UI (env OMAW_PORT, default 25257)
  --host <h>          Host to bind (env OMAW_HOST, default 127.0.0.1)
  --cwd <path>        Working directory for codex (env OMAW_CWD, default cwd)
  --codex-port <n>    app-server port (env OMAW_CODEX_PORT, default 25258)
  --codex-bin <name>  codex executable (env OMAW_CODEX_BIN, default "codex")
  --no-browser        Do not open the browser (env OMAW_OPEN=0)
  --help, -h          Show help
  --version, -v       Show version

  ws [options] ["msg"]  WebSocket client for the app-server
  ps [--json]           Running processes and their ports
  stop [--port <n>]     Stop the service listening on the UI port
  restart [options]     Stop the service, then serve again in the foreground
```

Flags win over environment variables.

Anything that is not a flag and not one of the subcommands above is rejected —
only `[options]` starts a server, so a mistyped subcommand can never silently
launch one.

### `oh-my-agent-web stop` / `restart`

Gracefully stop the service listening on the UI port (the same code path as
`npm run stop`): SIGTERM, then SIGKILL after an 8s grace period. It refuses to
touch the port if the listener is not one of ours.

```bash
oh-my-agent-web stop                 # stop on OMAW_PORT (default 25257)
oh-my-agent-web stop --port 3000     # stop the instance on another port
oh-my-agent-web restart --no-browser # stop, then serve again in this process
```

### `oh-my-agent-web ws` — WebSocket client

Connect straight to the app-server over its WebSocket (default
`ws://127.0.0.1:25258`), without going through the browser UI:

```bash
oh-my-agent-web ws                           # interactive: type a message, Enter to send (Ctrl-D to exit)
oh-my-agent-web ws "list the files here"     # one-shot, then exit
echo "write a hello world" | oh-my-agent-web ws
oh-my-agent-web ws --port 25259              # explicit port
oh-my-agent-web ws --url ws://host:port      # explicit address
oh-my-agent-web ws -t <threadId> "continue"  # resume an existing thread
oh-my-agent-web ws -y --model gpt-5.5 "..."  # auto-approve approvals, pick a model
```

Interactive mode prints the active model on connect and shows it in the prompt; use
`/model` to pick from the server's models with ↑/↓ + Enter (or `/model <name>` to switch
directly; applies from the next turn), `/help` for commands and `/quit` to exit. A turn
that fails with the upstream "prompt flagged" false-positive is retried automatically
once (`--retry <n>` / `--no-retry`).

Run the same client through npm (pass flags after `--`):

```bash
npm run ws                             # interactive
npm run ws -- --port 25259
npm run ws -- -t <threadId> "continue"
```

| Flag | Meaning |
| --- | --- |
| `--url <ws://host:port>` | Full address (bare `host:port` also works) |
| `--addr <host:port>` / `--host <h>` / `-p, --port <n>` | Address or port (default `127.0.0.1:25258`) |
| `--cwd <dir>` | Working directory (default: current dir) |
| `-t, --thread <id>` | Resume an existing thread |
| `--model <name>` | Model id (`/model` in interactive mode to list/switch) |
| `--sandbox <mode>` / `--approval <mode>` | Session sandbox / approval policy |
| `-y, --auto-approve` / `--decline` | Auto-answer approvals instead of prompting |
| `-v, --verbose` / `--json` | Print reasoning deltas / raw event JSON |
| `--timeout <sec>` | Max wait per turn (default 1800) |
| `--retry <n>` / `--no-retry` | Retry a flagged/transient turn up to n times (default 1) |
| `--retry-delay <ms>` | Base retry delay, default 1000 (grows per attempt) |

Env: `CODEX_WS_URL` / `CODEX_WS_HOST` / `CODEX_WS_PORT`.

Connection priority: `--url` > `--host`/`--port` (`--addr`) > env vars > defaults
(`127.0.0.1:25258`).

### `oh-my-agent-web ps` — processes & ports

Show every running oh-my-agent-web / codex app-server process, whether it is managed by
this project or external, and which TCP ports it listens on:

```bash
oh-my-agent-web ps            # table
oh-my-agent-web ps --json     # machine-readable
```

```
TYPE        PID    PPID   SCOPE     PORTS  COMMAND
app-server  16397  96476  managed   25258  node .../codex app-server --listen ws://127.0.0.1:25258
app-server  5567   5216   external  -      /Applications/ChatGPT.app/.../codex app-server ...
oh-my-agent-web   96476  1      -         25257  node bin/oh-my-agent-web.mjs --no-browser

ports: ui=25257  app-server=25258
  25257  listening: yes  pid: 96476
  25258  listening: yes  pid: 16398
```

## Environment variables

| Variable           | Default       | Meaning                                                          |
| ------------------ | ------------- | ---------------------------------------------------------------- |
| `OMAW_PORT`          | `25257`        | Web UI / HTTP port                                               |
| `OMAW_HOST`          | `127.0.0.1`   | Bind host (loopback by default)                                  |
| `OMAW_CWD`           | `process.cwd()` | Default working directory for codex                            |
| `OMAW_CODEX_PORT`    | `25258`        | app-server port                                                  |
| `OMAW_CODEX_BIN`     | `codex`       | codex executable                                                 |
| `OMAW_ALLOW_ORIGINS` | *(unset)*     | Comma-separated extra allowed WS origins. When unset: same-origin + localhost only |
| `OMAW_OPEN`          | *(unset)*     | `0` disables auto-opening the browser                            |
| `OMAW_REQUEST_INSPECTOR` | *(unset)* | Set to `1` to enable the loopback request/response capture proxy. Off by default; when off, no `chatgpt_base_url` / `model_providers.capture.base_url` overrides are injected |
| `OMAW_CODEX_UPSTREAM` | `https://chatgpt.com/backend-api/codex` | Upstream URL for the capture proxy |
| `OMAW_LOG_MAX_BODY` | `16 MiB`        | Maximum body retained per exchange                               |

## Architecture

- **`server/request-inspector.ts`** — optional (opt-in via `OMAW_REQUEST_INSPECTOR=1`)
  loopback Responses API proxy: forwards
  managed Codex traffic, redacts sensitive headers, incrementally captures SSE,
  persists `data/YYYY-MM-DD/*.json` with `0600` permissions, and serves
  thread-filtered summaries/details to the UI.
- **`server/codex-supervisor.ts`** — owns the `codex app-server` child:
  - Reuses a healthy app-server if the port already answers `GET /readyz`
    (external attach); otherwise spawns one.
  - Readiness via stdout (`listening on:`) **and** `/readyz` polling.
  - stdout/stderr → 500-line ring buffer (`omaw/codex/log`).
  - Auto-restart with exponential backoff (cap 10s), `restarts` counter.
  - Clean shutdown: SIGTERM then SIGKILL; only kills children **we** spawned.
- **`server/codex-client.ts`** — WS JSON-RPC client: `initialize` on every
  (re)connect, id-correlated `request()`, `notification` / `serverRequest`
  events, `respond()` / `respondError()`.
- **`server/fs-service.ts`** — `omaw/paths`, `omaw/fs/list`, `omaw/fs/read`.
- **`server/index.ts`** — express + `ws` hub, `/api/health`, `/api/version`,
  static SPA serving from `web/dist`, origin checks, 30s heartbeat.
- **`bin/oh-my-agent-web.mjs`** — CLI entry, loads `dist/server/index.js`.

## Browser ↔ server protocol

See [`shared/protocol.ts`](./shared/protocol.ts) for the frozen envelope.
Everything except `omaw/*` is proxied verbatim to codex.

Client → server: `rpc`, `reply`, `ping`.
Server → client: `welcome`, `status`, `rpcResult`, `event`, `serverRequest`, `pong`.

### Local methods (`omaw/*`)

| Method                | Params                        | Result                                   |
| --------------------- | ----------------------------- | ---------------------------------------- |
| `omaw/paths`            | —                             | `{ cwd, home, codexHome }`               |
| `omaw/fs/list`          | `{ path?, maxEntries? }`      | `{ path, entries: FsEntry[] }`           |
| `omaw/fs/read`          | `{ path, maxBytes? }`         | `{ path, text, truncated }`              |
| `omaw/codex/status`     | —                             | `{ status: CodexStatus }`                |
| `omaw/codex/restart`    | —                             | `{ ok: true }`                           |
| `omaw/codex/log`        | —                             | `{ lines: string[] }`                    |
| `omaw/request-logs/list` | `{ threadId, limit? }`       | Thread-filtered live/history summaries |
| `omaw/request-logs/detail` | `{ id }`                   | Full request/response exchange          |

`omaw/fs/list` sorts directories first and skips `node_modules` / `.git` unless
you are already inside one. `omaw/fs/read` refuses binary files (NUL byte) and
truncates at `maxBytes` (default 256 KB).

### Error codes

RPC failures come back as `{ type: "rpcResult", ok: false, error: { code, message, data? } }`:

| Code     | Meaning                                                        |
| -------- | -------------------------------------------------------------- |
| `-32001` | codex app-server not connected (proxy guard)                   |
| `-32002` | codex connection closed / client closed                        |
| `-32003` | local request timeout (initialize only)                        |
| `-32000` | generic fs / internal error                                    |
| `-32601` | unknown `omaw/*` method                                          |
| `-32602` | invalid params                                                |

### Approvals / server requests
Codex server→client requests (approvals, user input, dynamic tool calls) are
broadcast to **all** connected tabs as `serverRequest`. The first `reply` with a
matching `id` wins; later replies are ignored. After resolving, the server
broadcasts a codex-style notification:

```jsonc
{ "type": "event", "method": "serverRequest/resolved", "params": { "threadId": "...", "requestId": 123 } }
```

so other tabs can dismiss their dialog.

### Notes for the frontend

- Messages are accepted with or without `"jsonrpc": "2.0"`.
- `status.codex.pid === null && status.codex.phase === "ready"` means the server
  attached to an **external** app-server (it will not be killed on shutdown).
- The server re-sends `initialize` after every codex reconnect; browsers can
  hydrate a thread mid-session with `thread/read` (`includeTurns: true`).
- `ServerInfo.codexVersion` is parsed from the handshake `userAgent` and may be
  `null` until the first connection completes.

## Approvals never show up?

Codex routes escalation requests (sandbox escapes, blocked network access, MCP
prompts) to a **reviewer**, configurable per thread via `approvalsReviewer`:

| Value                | Behaviour                                                        |
| -------------------- | ---------------------------------------------------------------- |
| `user`               | Every request becomes a dialog in this UI                        |
| `auto_review`        | A prompted subagent decides — **no dialog is ever sent to the UI** |
| `guardian_subagent`  | Same idea, guardian variant                                      |

The default is `user`, but if your `~/.codex/config.toml` contains
`approvals_reviewer = "auto_review"` the browser will stay silent and commands
just run. Open **Settings → Who reviews approvals** and pick **Ask me** to route
them to this UI for a thread you start (or the running turn).

Read-only commands that the sandbox already allows never prompt at all — ask
codex to write outside the workspace (e.g. into `~`) or hit the network to
exercise the dialog.

## Frontend features

- **Thread sidebar** — paginated/searchable `thread/list`, rename, archive,
  delete, fork; status dots and relative times. The list shows **active threads
  only** and the project picker scopes it, so there is no active/archived tab;
  `Archive` is available from a thread's `…` menu and hides it.
- **Streaming transcript** — agent text, reasoning summaries, plans, live
  command output, `turn/diff/updated`. Deltas are coalesced on
  `requestAnimationFrame` so long turns stay smooth.
- **Markdown** rendering with GFM + syntax highlighting; `[path](/abs/path)`
  links open a file preview sheet backed by `omaw/fs/read`.
- **Command cards** — command, cwd, streamed output; only running/failed
  statuses are shown when they carry useful signal.
- **Diff cards** — unified-diff rendering with line numbers and +/- colouring.
  Note that codex's `FileUpdateChange.diff` is **not** always a diff: it is raw
  file content for `add`/`delete` and bare `@@` hunks for `update`, so the
  renderer normalises all three.
- **Approval dialogs** — command / file-change / user-input requests, with
  Accept, Accept for session, Decline, Cancel, plus an auto-approve toggle.
- **Composer** — Enter to send, Stop to interrupt, `@file` mentions via
  `fuzzyFileSearch`, image paste, message queueing while a turn runs.
- **Header** — model + reasoning effort, approval policy, sandbox, approvals
  reviewer, token/context meter, codex status + restart + log drawer.
- **Session logs** — open from the active thread's terminal icon or `…` menu;
  groups requests by turn, polls live exchanges, and provides readable,
  request JSON, response JSON, and raw SSE views. Capture is enabled for
  app-server processes managed by this project; an external app-server cannot
  be intercepted and will show no new captures.

## Skins

The UI ships four skins, switchable from the palette button in the header and
remembered per browser (`localStorage`):

| Skin | Look |
| --- | --- |
| **White** *(default)* | White canvas, grey chrome, blue accent — GitHub / pi-web style |
| **Warm paper** | Cream canvas, ochre accent, easier on the eyes |
| **Mist** | Cool grey-green canvas, teal accent |
| **Midnight** | Near-black canvas, violet accent |

Implementation notes:

- A skin is nothing but a `[data-theme="<id>"]` block of CSS variables in
  `web/src/styles.css`; the layout never changes between skins.
- `<html>` carries **two** attributes: `data-theme` (the skin) and `data-scheme`
  (`light` / `dark`). Rules that only make sense for light backgrounds — the
  syntax-highlighting palette, for instance — key off `data-scheme` so they are
  written once instead of per skin.
- The registry lives in `web/src/lib/theme.ts`. Adding a skin = one entry there
  plus one variable block in `styles.css`.
- `web/index.html` applies the stored skin in an inline script *before first
  paint*, otherwise the `:root` (dark) fallback flashes on load.

## Projects (workspaces)

The selector at the top of the sidebar switches the **project** — codex's `cwd`.
It is the app's primary navigation control:

- The list is derived from the `cwd` of known codex threads, so projects appear
  automatically as soon as you use them anywhere (CLI, TUI, this UI).
- Each row shows a compact path, a dot and the number of known threads; the
  current project is checked, and the app-server's default directory is pinned
  to the top.
- Selecting a project **re-scopes the thread list** (via `thread/list`'s `cwd`
  filter), clears the transcript, and becomes the `cwd` for new threads.
- `Use default directory` reverts to the app-server's cwd; `Custom path…` opens
  a thread in any directory you type. The choice persists across reloads.
- Counts come from a separate, **unscoped** `thread/list` (`refreshProjects`),
  because the visible list is filtered and therefore cannot provide totals.

## Layout controls

Everything about the workspace layout is draggable and remembered per browser:

| Control | How | Persisted as |
| --- | --- | --- |
| Collapse the sidebar | Header panel button, the `X` in the sidebar, or `⌘/Ctrl+B` | `cw-sidebar-collapsed` |
| Sidebar width | Drag its right edge (220–560px, max 50% of the window) | `cw-sidebar-width` |
| File panel width | Drag its left edge | `cw-file-panel-width` |

Details worth knowing:

- **Double-click a resize handle** to reset that panel to its default width.
- Widths are applied through CSS variables (`--sidebar-w`, `--file-panel-w`)
  rather than inline `width`, so the mobile media queries can still turn the
  sidebar into a drawer and the file panel into a full-height sheet. Resize
  handles are not rendered at all in those modes.
- Dragging uses **pointer capture**, so the drag survives the cursor leaving the
  handle or the window.
- `⌘/Ctrl+K` reveals the sidebar before focusing search, so it works while
  collapsed. `⌘/Ctrl+N` starts a thread, `⌘/Ctrl+B` toggles the sidebar.

## Composer

The message box is deliberately compact and self-sizing — there is nothing to
configure:

- It **hugs the pane**: 10px from either side (no centred column), with the text
  ~9px from the box's left edge and the Send button ~5px from its right edge.
- It is **one line tall** by default, with the Send button on the same row,
  vertically centred. The button is a flex sibling (not an overlay), so long
  text can never slide underneath it.
- It **grows automatically** as the text wraps, up to ~9 lines (200px); past
  that the textarea scrolls internally instead of pushing the transcript off
  screen. Deleting lines shrinks it back.
- `Enter` sends, `Shift+Enter` inserts a newline, and IME composition is
  respected (the keydown is ignored while composing).
- While a turn is running the row swaps to **Stop** + **Queue**, and queued
  messages are flushed automatically when the turn ends.

## Verification

`npm run smoke` runs a real end-to-end pass (spawns an app-server, starts a
thread, runs a turn, asserts streamed events, `thread/read` hydration, and
approval broadcast/dedupe).

The UI was additionally driven in headless Chromium against a real
`codex-cli 0.156.1` app-server and verified for: thread creation, streamed
turn completion, command cards, add/update/delete diff rendering, the full
approval round-trip (dialog → Accept → escalated command executes → turn
completes), all four skins, project switching (thread list re-scoping +
persistence across reload), sidebar collapse/expand, panel resizing
(sidebar 288→428px, file panel 560→740px, both persisted), and the composer
(48px / one line with Send on the same row → 87px at three lines → capped at
200px and scrolling at twenty lines → shrinks back) — plus no theme flash before
first paint and zero console errors throughout.

### Startup races and process ownership

Two things the server does so clients don't have to care:

- **Ready wait.** A browser can attach while `codex app-server` is still booting
  (or while the supervisor restarts it after a crash). Instead of failing the
  client's first `model/list` / `thread/list` with `-32001`, the proxy waits up to
  `CODEX_READY_WAIT_MS` (20s) for the app-server and only then reports an error.
  The UI additionally re-runs its codex-dependent bootstrap whenever the
  app-server transitions to connected, so a crash-restart recovers by itself.
- **Process-group ownership.** `codex app-server` re-execs: the spawned shim forks
  the real listener. The child is therefore started `detached: true` and stopped
  by signalling the whole **process group** (`-pid`), with a group `SIGKILL` on
  exit as a safety net. Signalling only the direct child would orphan the
  listener, which keeps the port bound — the next start would then "attach" to
  that stale process and `restart()` would be a silent no-op.

## License

MIT
