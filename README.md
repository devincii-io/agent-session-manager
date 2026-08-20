<p align="center">
  <img src="web/icons/app-128.png" alt="" width="88">
</p>

<h1 align="center">Agent Session Manager</h1>

<p align="center">
  A fast desktop workbench for the Claude Code and Codex sessions already sitting on your disk.
</p>

<p align="center">
  <a href="https://github.com/devincii-io/agent-session-manager/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/devincii-io/agent-session-manager?style=flat-square&color=e5813a"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%C2%B7%20Linux%20%C2%B7%20WSL-8899aa?style=flat-square">
  <img alt="Python" src="https://img.shields.io/badge/python-3.10%2B-4b8bbe?style=flat-square">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-6aa84f?style=flat-square"></a>
</p>

> **Unofficial community tool.** Not affiliated with or endorsed by Anthropic or
> OpenAI. Claude is a trademark of Anthropic, PBC. Codex and OpenAI are trademarks
> of OpenAI. The app indexes local agent session data and nothing else.

---

## The part I actually built this for

Set a goal with Claude Code's `/goal` and a Stop hook keeps the agent working
until the condition holds. What you get afterwards is a `.jsonl` file. What you
want is the story.

Open a goal and you see the whole run: every follow-up you sent while it was
active, every time the hook refused to let the agent stop and the reason it
gave, the files it touched, the commands it ran, and the moment the condition
was finally met.

![A goal, opened](docs/journey-goal.png)

Zoom out and the session becomes a clock. Goal bands on top, one row per prompt
below, idle gaps collapsed so a four-hour run fits on screen. Ten kinds of work
(read, search, edit, shell, web, subagent, plan, question, mcp, other) each
carry one colour, timed from the call to its result. The legend reads
`shell 489 · 1h 22m`, not a bare count.

![The Journey view](docs/journey.png)

---

## Everything else

<table>
<tr>
<td width="50%"><img src="docs/overview.png" alt="Overview"></td>
<td width="50%"><img src="docs/analytics.png" alt="Analytics"></td>
</tr>
<tr>
<td><b>Overview.</b> Spend, tokens, 90 days of activity, and the hours you
actually work.</td>
<td><b>Analytics.</b> Token composition, context pressure, compactions, cache
economics, the tools that failed, the files you kept coming back to.</td>
</tr>
<tr>
<td><img src="docs/transcript.png" alt="Transcript"></td>
<td><img src="docs/monitor.png" alt="Monitor"></td>
</tr>
<tr>
<td><b>Transcript.</b> User, assistant, thinking, tool calls and results, paged
so a 100 MB session opens on a tail window and loads earlier pages on demand.</td>
<td><b>Monitor.</b> What is running right now, plus the runtime state on disk:
shell snapshots, session env dirs, scratchpads, task boards.</td>
</tr>
<tr>
<td><img src="docs/cleanup.png" alt="Cleanup"></td>
<td><img src="docs/settings.png" alt="Settings"></td>
</tr>
<tr>
<td><b>Cleanup.</b> Filter, select, reclaim. Sessions active in the last ten
minutes are protected, and the backend rechecks immediately before deleting.</td>
<td><b>Settings.</b> A catalog-driven editor for <code>settings.json</code>.
Only keys you actually set get written, and removing one prunes it.</td>
</tr>
</table>

*(Every screenshot is generated demo data. Open `web/index.html` in any browser
to get the same preview, which is exactly how these were captured.)*

### Browsing

**Session browser.** *Recent* lists every session on the machine grouped Today /
Yesterday / This week. *Projects* expands a project in place. Arrow keys walk it,
`Enter` opens, `[` and `]` step between neighbours, and sessions you open stay as
tabs.

**Agent switcher.** `All | Claude | Codex` filters which sessions you see. It is
not a claim that a conversation can be converted between agents, because it
cannot.

**Environment switcher.** Windows and each WSL distribution are independent
sources. Enable only the distros you want in Settings. `All enabled` aggregates
Claude and Codex metrics without slowing the default Windows-only refresh.

**Global search.** Press Enter in the search box to search every session title
and first prompt plus your full prompt history, with jump-to-session.

### Reading a session

Past the transcript and the journey there are context meters (the
statusline-style 10-slot meter, reconstructed per session from
`input + cache_read + cache_write` over the context window), subagent sidechains
and `Agent` / `Task` invocations, the per-session scratchpad tree, the task
board, background-task output, and a thumbnail gallery of Claude uploads and
legacy image-cache files.

Cost is labelled honestly. Claude gets an explicit API-price estimate. Codex
ChatGPT-plan usage is never dressed up as dollars.

### Writing things back

**Memory.** The project `memory/` store, its `MEMORY.md` index and the
individual files with their frontmatter, editable and deletable in place.

**Instructions.** Drive your own signed-in `claude` CLI over your history to
refine a CLAUDE.md (global or per-project), or consolidate sessions into memory
notes. Headless, async, cancellable, backed up before writing. Only session
summaries go to the CLI, never full transcripts. Codex gets safe `config.toml`
and `AGENTS.md` editing with the same backups. The app deliberately does not
auto-synchronize AGENTS.md and CLAUDE.md.

**Privacy defaults.** One tap keeps sessions off claude.ai, kills non-essential
traffic, and disables telemetry and error reporting.

**Live statusline capture** (opt-in). Rate limits (5h / 7d) and live context
percentage never touch disk. Claude Code hands them to your statusline command
and nowhere else. A one-line hook, removable at any time, lets the app read the
latest values.

**Quick launch.** Start or resume either agent with the right provider-aware
command. On Windows the documented `codex://` deep link covers the case where
the Store CLI alias is missing. WSL launches run inside the owning distro with
its raw Linux working directory. Set `CODEX_CLI_PATH` for a native terminal
launch.

Buttons throughout open paths in VS Code or your file manager. Deletions always
confirm first.

---

## Speed

Transcripts get big. The whole design falls out of that.

- Streaming `orjson` parsing. A cold 10 MB Claude transcript summarizes in
  about 40 ms.
- Summaries cached on disk, keyed by mtime and size.
- Incremental parsing. While a session is live only the newly appended bytes
  are read, roughly 0.1 ms per refresh, never the whole file again.
- Paged transcripts. The backend serves a small window and loads earlier pages
  on demand, so a 100 MB session opens straight onto its tail.
- Path-aware filesystem events refresh the affected view instead of rebuilding
  global analytics.
- Codex rollouts are grouped by canonical working directory, parsed lazily, and
  read cumulative token snapshots correctly. Subagent rollouts do not inflate
  the session count.
- WSL distro names are discovered cheaply and stay off by default. A distro is
  resolved and scanned only once you enable and select it.

## Keyboard

![The command launcher](docs/commands.png)

`Ctrl+K` opens every command. `Ctrl+P` quick-opens a session. `↑` and `↓` walk
the browser, `[` and `]` step between neighbouring sessions. `Ctrl+F` filters,
`Ctrl+Shift+F` searches all prompt history. `Ctrl+N` starts the selected agent
in the current project, `Ctrl+Enter` resumes the selected session. `Ctrl+B`
collapses the browser, `Ctrl+Shift+L` switches theme. Press `?` in the app for
the full reference.

## Themes

![Light theme](docs/light.png)

Every colour in the app resolves to a token in `web/css/tokens.css`. A hex
literal anywhere else is a bug, because it would be wrong in one of the two
themes, and a test enforces it.

---

## Install

Download `AgentSessionManager-v<version>-Setup.exe` from the
[latest release](https://github.com/devincii-io/agent-session-manager/releases/latest).
The per-user installer needs no administrator access, adds a Start Menu entry,
offers a Desktop shortcut, upgrades in place, and uninstalls normally. The app
watches the same release feed in the background and will only open an update
after both its exact installer filename and its SHA-256 checksum verify.

For a no-install copy, take the Windows portable ZIP and keep its whole
`AgentSessionManager` folder together. Linux ships as a portable single-file
executable. Verify any release file against `SHA256SUMS.txt`.

## Run from source

```bash
uv sync
uv run asm
```

`uv run python -m asm.app` works too. Python 3.10 or newer. The GUI needs a
display. On WSL, WSLg works out of the box.

## Where the data lives

| Agent | What | Path |
|---|---|---|
| Claude | Config home | `~/.claude` or `$CLAUDE_CONFIG_DIR` |
| Claude | Sessions | `~/.claude/projects/<encoded-path>/<session>.jsonl` |
| Claude | Memory / tasks | `~/.claude/projects/.../memory/`, `~/.claude/tasks/...` |
| Codex | Data home | `~/.codex` or `$CODEX_HOME` |
| Codex | Sessions | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Codex | Settings / instructions | `$CODEX_HOME/config.toml`, `AGENTS.md` |
| WSL | Per-distro agent homes | `\\wsl.localhost\<distro>\...\.claude`, `.codex` |

Browsing and analytics stay on your machine. Writes happen only after an
explicit action, are path-guarded, and back up any instruction or config file
before overwriting it. The one exception to "no network" is deliberate and
labelled: instruction optimization invokes your own signed-in CLI with selected
summaries, which contacts that agent's service. Full transcripts are never sent.

## Build

```bash
uv sync --extra build
uv run pyinstaller --noconfirm AgentSessionManager.spec
```

Windows produces `dist/AgentSessionManager/`, an on-disk bundle rather than a
one-file executable, which avoids paying multi-second Qt WebEngine extraction on
every launch. Build the per-user installer with Inno Setup 6:

```powershell
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" /DAppVersion=3.1.0 packaging\agent-session-manager.iss
Copy-Item README.md,LICENSE -Destination dist\AgentSessionManager
Compress-Archive -Path dist\AgentSessionManager -DestinationPath dist\AgentSessionManager-v3.1.0-Windows-x64-portable.zip -Force
```

On Linux the same spec produces one portable `dist/AgentSessionManager`. The
build keeps only the English and German Qt locales, drops Tk, splash payloads
and unused QML plugins, and bundles Linux compatibility files only on Linux.
PyInstaller cannot cross-compile, so run it on the target OS. From WSL or Linux
the guarded release helper builds in an isolated temporary environment:

```bash
bash packaging/build-linux.sh 3.1.0
```

Before publishing, write `dist/SHA256SUMS.txt` with an entry for every artifact.
Automatic installation deliberately requires the exact names
`AgentSessionManager-v<version>-Setup.exe` and `SHA256SUMS.txt`. Rename either
and the app falls back to opening the release page.

## Architecture

Built with PySide6 and QtWebEngine, managed with uv. Three runtime dependencies:
PySide6, watchdog, orjson. The frontend is vanilla JS with no build step.

```
asm/
  paths.py                 cross-platform Claude and Codex path resolution
  sources.py               lazy native/WSL source discovery and path context
  session_parser.py        streaming .jsonl parser (summary + detail)
  codex_session_parser.py  tolerant Codex rollout adapter
  codex_scanner.py         Codex project/session index and locator map
  goals.py                 /goal runs, per-prompt segmentation, tool timing
  scanner.py               enumerate projects, sessions, memory, tasks, settings
  pricing.py               model price table and cost math
  watcher.py               watchdog to Qt signals (live updates)
  actions.py               delete, bulk-delete, save, settings, statusline hook
  assistant.py             headless `claude` CLI prompts and output parsing
  update.py                release-feed check and checksum-verified install
  bridge.py                the QWebChannel object exposed to JS
  app.py                   QApplication and the QWebEngineView shell
web/
  index.html               the shell, loads everything below
  css/                     tokens (both themes), base, shell, components,
                           charts, journey, views
  js/core/                 state, the QWebChannel client, formatting, theming
  js/ui/                   charts, markup primitives, toasts, dialogs
  js/views/                one file per view; journey.js owns the canvas ribbon
  js/preview.js            fixtures that make web/index.html work in a browser
```

## Docs

[CHANGELOG](CHANGELOG.md) · [CONTRIBUTING](CONTRIBUTING.md) ·
[LICENSE](LICENSE) · [vendor/NOTICE](vendor/NOTICE)
