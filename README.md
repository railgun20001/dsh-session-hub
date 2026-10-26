# dsh-session-hub — Session Status Hub for DeepSeek Harness

[![CI](https://github.com/railgun20001/dsh-session-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/railgun20001/dsh-session-hub/actions/workflows/ci.yml)
**English** · [简体中文](README.zh-CN.md)

A missing "how are all my Sessions doing right now?" surface for [DeepSeek Harness](https://github.com/deepseek-ai):

- **A rail in the top title bar** listing the Sessions that need you, ordered by
  `red (failed) > yellow (waiting for your answer) > green (unread) > blue (running)`.
  One click jumps straight to that Session.
- **Windows notifications** when a Session changes state (finished / failed / needs an
  answer), where clicking the toast reopens the Session and brings the DSH window forward.
- **Taskbar status dot** on the DSH taskbar button (red / yellow / green, priority
  `red > yellow > green`), via `ITaskbarList3.SetOverlayIcon` — visible while the window is
  minimized or buried behind other apps, including when the conversation you are *looking
  at* finishes in the background (the stock UI marks nothing for the main view; this
  plugin fills that gap).

> Full, behaviour-level documentation (state machine, notification edge engine, the measured
> Windows toast `tag` limit, taskbar worker internals, every known boundary) is in the
> Chinese doc: **[README.zh-CN.md](README.zh-CN.md)**.

---

## States and priority

| State | Determined by | Rail chip | Taskbar |
|---|---|---|---|
| **failed** `error` | `hubTurnOutcome.outcome ∈ error / interrupted`, not yet acknowledged | 🔴 + 报错 | red (highest) |
| **waiting** `answer` | `pendingInteraction.kind ∈ approval / plan-review / question` | 🟡 + 等待回答 | yellow |
| **unread** `unread` | `completionUnread === true`, or the plugin's own "finished in background" record | 🟢 + 待查看 | green |
| **running** `running` | `sessionStatus.running`, or the Session row's `running` | 🔵 + 运行中 | **no dot** |

- Chip order is the colour order (red > yellow > green > blue); within a state, most
  recently updated first. The 3 chips shown by default are therefore always the 3 that
  most need you.
- Classification order (which bucket a Session lands in) is independent of display order:
  waiting > failed > running > unread.
- **Running never lights the taskbar.** Running is the normal case; lighting it would leave
  the dot permanently green and mask real red/yellow signal. It still shows as a blue
  pulsing chip.
- Blank "new session" rows and subagent Sessions (`origin: subagent`) are ignored.
- A "failed" chip clears when you click it or when you are looking at that Session with the
  window focused; a new failure re-lights it.

### Why the plugin records unread state itself

The stock `ui-session` only sets `completionUnread` when a turn ends in a Session that is
*not* the main view — so "I was reading this conversation, switched to another app, the turn
finished" produces nothing: no dot, no taskbar mark, no rail chip. The plugin observes the
same edge and, when the window is not in the foreground, records the completion itself
(`localStorage` `dsh-session-hub/local-unread-v1`) so the green dot, the green taskbar mark
and the 待查看 chip all appear. It clears when you come back and look at that Session, or when
you click its notification/chip.

## Notification categories

| Notification | Trigger | Default |
|---|---|---|
| **Needs your response** | a `pendingInteraction` appears / changes key | ✅ |
| **Turn failed** | new turn outcome `error` / `interrupted` (incl. account signed-out hook) | ✅ |
| **Turn completed** | new turn outcome `completed` | ✅ |
| **Output limit reached** | new turn outcome `max-tokens` | ✅ |
| **Turn stopped** | `aborted` (you pressed stop) | ❌ |

No notifications for "thinking… / running a tool…" streaming activity — that is where most
notification plugins become noise. Titles carry a colour emoji (🟢 done, 🟡 needs you, 🔴
failed, 🟠 max-tokens) from the same palette as the rail and the taskbar dot; Windows toasts
always use the app icon, so text is the only place colour can live.

## Requirements

- DeepSeek Harness with the `sessionProjections`, `sessions` and `uiSession` services (any
  recent desktop or web build).
- Node.js ≥ 20 for the host half (DSH ships its own; nothing to install — the plugin has
  **zero npm dependencies**).
- Windows 10/11 for window raising and the taskbar dot (PowerShell 5.1 + Win32). The rail,
  notifications and navigation also work in the web UI.

## Install

```powershell
git clone https://github.com/railgun20001/dsh-session-hub.git
```

Then, either:

- **DSH → Plugins page → add local plugin**, and pick the cloned `dsh-session-hub` directory;
  or
- **plugin manager** (if your session exposes a `plugin_manager` tool) → `install_bundle`
  with that directory as the target.

After installing: the host half (`index.js`) hot-loads with the profile — no restart. The
client half (`lib/client.js`) needs a page reload (`Ctrl+R`). Uninstalling removes the
taskbar dot automatically.

## Configuration

Config lives in `localStorage` under `dsh-session-hub/config-v1`; defaults are already
"don't disturb me":

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch (watermarks keep advancing; re-enabling never replays history) |
| `onComplete` / `onFailure` / `onAnswer` | `true` | completed / failed / needs your response |
| `onMaxTokens` | `true` | output-limit hits |
| `onStopped` | `false` | manual stop / interrupt |
| `includeSubagents` | `false` | also notify and list subagent Sessions |
| `silenceCurrentWhenFocused` | `true` | stay silent for the Session you are currently reading |
| `silenceAllWhenFocused` | `false` | never notify while the window is focused |
| `requireVisibleForFocus` | `true` | minimized/hidden counts as unfocused (notify anyway) |
| `freshnessWindowMs` | `120000` | edges older than this only advance watermarks (`0` disables) |
| `sound` | `true` | system notification sound |
| `colorMarkers` | `true` | colour emoji in notification titles |
| `colorMarkers` | `true` | colour emoji in notification titles |
| `raiseWindow` | `true` | bring the desktop window forward on notification click |
| `maxRememberedSessions` | `300` | cap on the notification watermark table (newest by `updatedAt` kept) |

Alongside `config-v1`, the plugin keeps a few state keys under the same prefix — worth knowing
when troubleshooting, migrating or wiping data:

| Key | Contents |
|---|---|
| `watermarks-v1` | notification watermarks: how far each Session has been consumed |
| `error-acks-v1` | acknowledged failures `{ sessionId: seq }` (what turns the red chip off) |
| `local-unread-v1` | plugin-recorded "finished in background, unseen" `{ sessionId: seq }` |
| `recent-v1` | cross-tab dedupe window (4 s) |
| `notify-log-v1` | last 20 notification landing results |

From the DSH DevTools console:

```js
__DSH_SESSION_HUB__.getConfig()
__DSH_SESSION_HUB__.setConfig({ silenceAllWhenFocused: true })
```

`enabled` / `onComplete` only mute *notifications* — the unread dot and the taskbar mark are
state facts ("this turn finished and you haven't looked"), not interruptions.

## Diagnostics

```powershell
npm run check     # 1) lib/client.js matches src/  2) 101 test cases
```

```js
__DSH_SESSION_HUB__.inspect()            // versions, services, focused, hostHalf, rows, taskbar
__DSH_SESSION_HUB__.getRows()            // current rail rows
__DSH_SESSION_HUB__.getTaskbarState()    // red / yellow / green / none
__DSH_SESSION_HUB__.getLocalUnread()     // plugin-side "finished in background, unseen" records
__DSH_SESSION_HUB__.testNotification()   // fire a test toast; clicking it should jump back
__DSH_SESSION_HUB__.getNotifyLog()       // last 20 notification landing results
__DSH_SESSION_HUB__.pingHost()           // 'present' / 'absent' / 'unknown'
```

Host half, read-only:

```powershell
# The origin follows your DSH instance: whatever origin serves the page also serves these
# routes (the desktop shell forwards same-origin paths to the host). Example: the web UI at
# http://127.0.0.1:8779/.
$base = 'http://127.0.0.1:8779'
Invoke-RestMethod -Uri "$base/dsh-session-hub/ping"  -Method POST
Invoke-RestMethod -Uri "$base/dsh-session-hub/debug" -Method POST
```

## Architecture

```
dsh-session-hub/
├── index.js                 host half: hubTurnOutcome projection + routes
├── lib/raise-window.js      host half: window raise + taskbar dot (resident PowerShell worker)
├── lib/client.js            client bundle (generated by build/bundle.mjs — do not edit)
├── src/hub-model.js         rail + taskbar logic (pure, unit-testable)
├── src/notify-core.js       notification edge engine (pure, unit-testable)
├── src/hub-scroll.js        sidebar row reveal/scroll (pure, unit-testable)
├── src/hub-ui.js            React rail + row hint components
├── src/client-main.js       wiring: services → model → notifications / rail / taskbar
├── build/bundle.mjs         inlines the five sources into one classic-script bundle
├── test/                    101 node:test cases, zero dependencies
├── locale/{zh,en}.json      plugin manager title and description
├── icon.svg                 plugin icon
├── cordis.patch.yml         bundle patch inserting the session-hub row
├── .github/workflows/ci.yml CI: bundle-in-sync check + full test run
└── LICENSE                  MIT
```

Why the plugin computes edges itself: DSH hands the client *current state*, not an event
stream (`running` is a boolean, `pendingInteraction` the current value, the projection the
last turn's outcome). Notifications therefore have to be derived from state edges, in exactly
one implementation (`planNotifications`), which also reports "this turn really ended" so the
client can record unread state the stock UI never sets for the main view.

Why failure detection needs the host half: the client cannot see *why* the previous turn
ended. `turn/end` carries `reason.kind`, but only for retained Sessions. A session projection
is the supported answer: the framework folds **all** Sessions (cold ones included), and the
value reaches the client through three supported channels. The plugin therefore retains no
Session at all.

## Known boundaries

- The taskbar dot and window raising are **Windows-only**; in a plain browser
  (`desktopShell === false`) nothing is reported.
- Window raising depends on the Windows foreground lock; fullscreen apps, elevated (UAC)
  windows and RDP switches can still refuse. In-app navigation always happens.
- The first notification click may be slow (the worker compiles C# once, ~6 s on a slow
  machine); the worker is pre-warmed as soon as a notification is shown, and clicks queue.
- Notification `tag`s are capped at 15 characters on purpose: a long `tag` makes Chromium
  drop the whole toast silently — the measured table is in the Chinese doc.
- Sidebar scrolling relies on the official `data-row-key` convention; if upstream changes it,
  scrolling degrades silently (navigation is unaffected). `revealSessionRow(id)` returns
  `null` when that happens.
- Failed/unread marks do not expire on their own: failures need an explicit ack, unread needs
  you to open the Session.
- The "failed" state cannot be painted on the official sidebar row dot (the upstream row
  state machine has no error state), so the truth is surfaced in the row hover card instead
  (`本轮失败` / `本轮中断`).

## Security and privacy

- **No outbound network calls.** The plugin only talks to the local host half
  (`dsh-session-hub/*` same-origin routes) — no telemetry, no analytics, no third parties.
- **Everything stays on this machine**: config, watermarks, error acks, unread records and
  the notification landing log live in `localStorage` under the `dsh-session-hub/` prefix.
  The plugin never reads conversation content — only the last turn's outcome and a few state
  booleans.
- **Internal routes carry no extra auth**: `/raise`, `/warmup`, `/taskbar` only affect the
  window and the taskbar icon and return no user data (`/debug` returns projection keys,
  versions and process state). Do not expose the DSH web port to an untrusted network.
- **The host half spawns one PowerShell process** (`-NoProfile -EncodedCommand`, no script
  file written, no execution-policy change). The worker script is in `lib/raise-window.js`;
  set `raiseWindow: false` to skip window raising.

## Contributing

`npm run check` must pass (bundle in sync with `src/`, all tests green). `lib/client.js` is
generated: edit `src/` and run `npm run build`, never edit the bundle by hand. Commits follow
Conventional Commits with a Chinese subject and a body describing the change and its impact.

## License

[MIT](LICENSE) © 2026 railgun20001
