# Session event popup

[简体中文](README.md) · [English](README_en.md)

[![npm version](https://img.shields.io/npm/v/session-toast-notification)](https://www.npmjs.com/package/session-toast-notification)
[![GitHub stars](https://img.shields.io/github/stars/Jae1010/session-toast-notification?style=social)](https://github.com/Jae1010/session-toast-notification)
[![license](https://img.shields.io/npm/l/session-toast-notification)](LICENSE)

**Session notifications for [DeepSeek Harness](https://www.deepseek.com/harness/): a desktop toast when a turn ends, when the agent asks you something, or when a tool needs approval — and you can answer, approve or jump back from the notification itself.**

With several sessions running in parallel, the notification carries the session title, working directory, elapsed time and a short summary, so you can tell which task is waiting for you. Clicking it opens that session.

## Install / update

Needs DSH 0.2.2-rc.5 or later (`engines.dsh` is checked at install time). Windows 10/11 is fully supported; macOS is beta (see below).

```sh
dsh plugin --profile web add session-toast-notification
dsh plugin --profile web update session-toast-notification@latest
```

Or use **Plugins → Add plugin** in DSH, search `session-toast-notification`, install, then reload the page once (`Ctrl+R`) so the plugin page and Settings → Popups show up.

From a market index source (Plugins → Discover → index sources), add either URL and search the package name:

```
https://cdn.jsdelivr.net/gh/Jae1010/session-toast-notification@main/market/index-git.json   # straight from GitHub, no npm package needed
https://cdn.jsdelivr.net/gh/Jae1010/session-toast-notification@main/market/index.json       # from npm (once published)
```

## What a notification looks like

```
✅ Session finished · Popup plugin development
Took 4m12s · Folder dsh\popup
The plugin is installed and verified end to end…
```

```
❓ Answer needed · Popup plugin development
Folder dsh\popup
Detail · Should the toast also show token usage?
```

- Line 1: outcome + session title (falls back to the start of the first prompt)
- Line 2: elapsed time + last two path segments, so parallel sessions are distinguishable
- Line 3: the ending summary, the question itself, or the operation awaiting approval

| Outcome | Marker |
| --- | --- |
| finished | `✅ Session finished` |
| aborted | `⏹ Session aborted` |
| blocked | `⏸️ Session blocked` |
| error | `❌ Session errored` |
| output limit | `⚠️ Output limit` |
| interrupted | `🔌 Session interrupted` |
| goal complete / blocked | `🎯 Goal complete` / `⛔ Goal blocked` |
| question / approval | `❓ Answer needed` / `🔐 Waiting for approval` |

## Behaviour

- Fires when `agent/status` turns `idle` — the moment a turn actually ends. Sessions that never started running do not notify.
- Question and approval notices are driven by the session log (`tool/call` for `ask_user_question`, the `approval/asked` audit event), because the web relay claims those waterfalls first and never calls `next()`.
- Clicking the body of a question toast answers it: one button per option, up to three, for a single question. A batch (1/3, 2/3 …) is walked one question at a time — each click posts the next question as a new toast, and only the last click submits the whole answer set. If any question needs free typing, the toast only reminds you.
- Approval toasts carry exactly the two buttons the in-app card has (allow once / deny). The request is held for `approvalTimeoutMs` (180s by default) and handed back to the app if you do not answer, so the agent never gets stuck. Clicking those buttons does not steal focus.
- While you are looking at a session (window focused, that session on screen), its own notices stay quiet; other sessions still notify.
- Goal mode (auto-continuing rounds) only notifies on the last round — complete or blocked.
- Volume and quiet hours are set per kind (finished / question / approval); volume 0 or a quiet window keeps the toast silent but still visible.
- Optionally blinks the taskbar button (`FlashWindowEx`, Windows only) until the window comes forward.

## Settings

Two entries, same switches: the plugin page (full write-up) and **Settings → Popups** (configuration only). Everything takes effect immediately and is stored in `%DSH_HOME%\session-toast\settings.json`, which overrides `cordis.patch.yml`.

- **Notifications**: finished / question / approval, taskbar blink
- **Behaviour**: reply inside the toast, click to open the session, respect focus, hold back during goal rounds
- **Sounds**: three sound pickers (3 system sounds, 8 bundled effects, silent), custom `.wav`/`.mp3` files by name, volume sliders, quiet windows with 15-minute pickers

## Platforms and compatibility

- **Windows 10/11**: full capability — WinRT toast with buttons, MCI playback with volume, `FlashWindowEx`, `dsh-session-toast:` protocol callbacks.
- **macOS 14+ (beta)**: reminders only — notifications come from the page via the Web Notifications API (falling back to `osascript`), sounds via `afplay`. No buttons, no taskbar blink. Written but never verified on a real Mac; expect rough edges.
- **Linux**: not implemented.

Interface-by-interface compatibility, the verification status per DSH release, and a five-step self-check are in [docs/compatibility.md](docs/compatibility.md).

## License

[MIT](LICENSE)
