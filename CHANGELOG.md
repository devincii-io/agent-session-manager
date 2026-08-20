# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [3.1.0] — 2026-08-20

3.0.0 called every prompt a "goal". That was the wrong word for the wrong thing.
A **goal** is Claude Code's `/goal` — a session-scoped Stop hook that blocks the
agent from finishing until its condition holds. This release tracks the real
one, and measures what happened while it ran.

### Added
- **Goal runs**, reconstructed from the transcript's own `goal_status`
  attachments: when the goal was set, every time the Stop hook refused to let
  the agent finish (with its reasoning), and the moment the condition was
  finally met. A goal that was replaced by a later one is kept and marked
  replaced; one that was still active when the transcript ended is measured and
  marked open, never quietly closed.
- **Goal analysis** — how long it ran, the follow-ups you sent while it was
  running, turns, tool calls, time inside tools, errors, compactions, tokens
  and the price estimate. Opening a goal shows everything that happened inside
  it: every tool call in order, each prompt you sent, the files touched, the
  commands run, and each blocked stop with the hook's reasoning.
- **Time per kind of work.** Every tool call is timed from the call to its
  result, and the legend now reads `shell 489 · 1h 22m` rather than a bare
  count. Parallel calls of the same kind are counted once — three greps at the
  same time are not three grep-minutes — so the figures are wall clock, not a
  sum of durations.
- A **goal band** across the top of the timeline ribbon showing what was
  running and for how long, with a tick at every blocked stop. Clicking a band
  narrows the prompt list to that goal.
- Sessions with no goal say so, and explain what `/goal` does, instead of
  inventing goals out of prompts.

### Changed
- The per-prompt segments introduced in 3.0.0 are now called **prompts** and
  are subordinate to goals, which is what they always were.
- Work is attributed to a goal as it happens rather than by matching timestamps
  afterwards. The old approach charged a long-running prompt to whichever goal
  contained its *start*, which put nine hours of work under a goal that lasted
  forty-four seconds.

### Fixed
- The Stop-hook directive Claude Code injects into the user role no longer
  appears as something you typed — it is the goal, and it is shown as one.
- `<task-notification>` blocks are recognised as CLI scaffolding, so background
  task results no longer appear in the prompt list.
- The timeline's hover readout is no longer clipped by the ribbon's own edge;
  it overhangs the box and flips above the row only when the window demands it.

## [3.0.0] — 2026-08-20

A session is not a wall of messages. It is a sequence of things you asked for,
each with a beginning, an end, and a stretch of work in between. This release
rebuilds the app around that idea, and rebuilds the interface it is shown in.

### Added
- **Journey** — a new default view for every session. The backend segments the
  transcript into **goals**: one per prompt you sent, spanning until the next
  one arrives. Each goal records when it started and ended, how long the first
  reply took, which *kinds* of tools ran inside it, whether the agent stopped to
  ask you something, what failed, and what it cost.
- A time-axis **ribbon** drawing one row per goal on a shared clock. Idle gaps
  are collapsed to a labelled band, so an overnight pause costs the chart a few
  pixels instead of two-thirds of its width, and every tool call appears as a
  tick in its category colour. Hover for a readout, click to inspect.
- A **goal inspector**: the prompt, duration, first-reply latency, every step in
  order, the tools that failed, the files touched and the commands run.
- Ten **work categories** — read, search, edit, shell, web, subagent, plan,
  question, mcp, other — with one colour each, used identically in the journey
  ribbon, the per-goal bars, the tool-usage chart and the transcript.
- A **light theme**, and a full second palette behind it. Every colour in the
  app now resolves to a design token; `Ctrl+Shift+L` switches.
- A **session browser** in the sidebar with two modes: *Recent* (every session
  on the machine, grouped Today / Yesterday / This week) and *Projects*
  (expanding in place). Arrow keys walk it, Enter opens, `[` and `]` step
  between neighbouring sessions, `Ctrl+B` collapses it.
- **Session tabs** for recently opened sessions, so getting back to what you
  were looking at is one click.
- New charts: a 90-day activity calendar with month labels, a weekday-by-hour
  heatmap of when you actually work, and per-project token and cost trends.
- Goal segmentation and tool categorisation are covered by their own tests,
  including a check that feeding a live session incrementally produces exactly
  the same goals as parsing it in one pass.

### Changed
- The frontend was rewritten from one 2,900-line file into `web/css/` and
  `web/js/` modules, each an isolated unit over a single shared namespace.
  There is still no build step.
- Global statistics now keep 90 days of daily activity (was 14) and a
  weekday-by-hour distribution.
- Session listings carry the context percentage, so the sidebar can show a
  context meter without opening the session.
- Monetary values are formatted by `Intl` rather than by concatenating a
  currency symbol onto a grouped number, which produced `$1.998` for `$1,998`
  in locales that group with dots.

### Fixed
- CLI scaffolding that arrives in the user role — command echoes, captured
  stdout, injected reminders, Codex environment and plugin blocks — no longer
  opens a goal or appears as something you typed.
- A tool result that arrives after you have already sent the next prompt is
  charged to the goal that made the call, not to the one you just started.
- Session titles in the sidebar no longer overlap their timestamps.
- Codex goals carry token counts and no dollar figure; ChatGPT-plan usage is
  never presented as API spend.

## [2.0.4] — 2026-07-26

### Changed
- The permanent sidebar has been removed. View, agent, environment, and project
  selection now live in one top-bar control plane without duplicate navigation.
- Overview and management screens use the full window; selecting a project opens
  only its contextual session pane and detail workspace.
- New Session is directly available in the top bar and uses the selected project
  or the most recent available project.
- Sessions have their own top-bar picker; Search filters both the session picker
  and session pane, while Enter searches the complete history.

### Fixed
- Compact and wide layouts now share the same project navigation instead of
  switching between hidden, icon-only, and duplicated sidebar variants.
- The packaged render self-test validates the top-bar navigation contract.

## [2.0.3] — 2026-07-26

### Changed
- Navigation now uses compact view, agent, environment, project, session-status,
  and session-sort controls with a visible sidebar toggle and grouped sections.
- Compact windows retain direct project access instead of hiding the only project
  list, and new sessions launched from Overview use the latest available project.
- Large session and asset collections render in bounded batches; project filtering
  is animation-frame throttled and cleanup search is debounced.

### Fixed
- Rapid project, session, search, or cleanup navigation can no longer display a
  stale response from an earlier selection.
- Quick Open no longer keeps unusable session entries after leaving a project.
- Cleanup presets reset unrelated criteria, session and asset filters remain
  independent, and asset filter controls accurately reflect active values.

## [2.0.2] — 2026-07-21

### Changed
- Fullscreen dashboards now use the available detail pane; widescreen analytics
  arrange related cards in balanced columns.
- Project navigation and session-list panes can be resized by mouse or keyboard,
  with widths remembered per machine.
- Wide session cards place their context and badges alongside metadata for a
  clearer scan path.

### Fixed
- Responsive pane bounds preserve a usable detail area while preventing
  horizontal overflow on compact windows.

## [2.0.1] — 2026-07-21

### Fixed
- Analytics bars now render their calculated percentage widths correctly.
- The desktop window opens inside the current display's usable area instead of
  extending off-screen on compact, remote, portrait, and high-DPI displays.
- The top bar, three-pane workspace, analytics, filters, settings, dialogs, and
  status bar now reflow cleanly as the window is resized.

## [2.0.0] — 2026-07-21

### Added
- A per-user Windows installer with Start Menu integration, optional Desktop
  shortcut, uninstall support, and in-place upgrades without administrator access.
- A Windows portable ZIP distribution and checksum-verified in-app release updater.
- The repository, Python distribution, module, CLI, executable, cache, and build
  identities are now consistently named Agent Session Manager.

### Changed
- Windows now ships as an on-disk application bundle for much faster cold starts;
  Linux retains the portable single-file build. Unused Qt QML plugin catalogs
  are omitted from both packages.
- The canonical repository is now `devincii-io/agent-session-manager`; browser
  preferences and legacy statusline hooks migrate without losing user state.

## [1.2.0] — 2026-07-21

### Added
- Independent environment switching for Windows, each opt-in WSL distribution,
  and `All enabled`, orthogonal to the `All | Claude | Codex` agent switcher.
- Lazy WSL discovery, per-distro Claude/Codex scanning, aggregate metrics, and
  source-correct resume/new/fork/archive commands executed inside the distro.
- Cleanup filters for search, age, size, state, turns, and asset category plus
  an explicit `Select matching safe` action.
- A separate asset cleanup inventory for current uploads, legacy images, file
  history, tasks, session environments, scratchpads, and orphaned groups.

### Changed
- Windows remains the only enabled environment by default. Disabled WSL sources
  incur no scan cost; all-source metrics include enabled sources only.
- Cleanup now separates permanent Claude reclaim from Codex archive size and
  reports Codex archive as `0 B` reclaimed.
- The standalone build omits Tk/splash payloads, unused Qt locales, and Windows
  copies of Linux-only compatibility files.

### Fixed
- Codex archived threads are read from its newest compatible state database in
  read-only mode and no longer appear in active project/session views.
- Current `~/.claude/uploads` images are indexed alongside legacy image-cache.
- Recently written orphan assets are protected, scratchpad deletion is strictly
  rooted, source IDs prevent Windows/WSL selection collisions, and truncated
  config files can no longer be saved over their full originals.

## [1.1.0] — 2026-07-21

### Added
- **First-class Codex support** alongside Claude Code, with a persistent
  `All | Claude | Codex` switcher, provider badges, unified project/session
  browsing, global search, transcripts, analytics, and provider-aware commands.
- A version-tolerant Codex rollout adapter that uses canonical metadata IDs,
  groups sessions by working directory, excludes subagent rollouts from root
  counts, de-duplicates message channels, and treats token snapshots as
  cumulative rather than additive.
- Codex quick launch/resume (including documented Windows desktop deep-link
  fallback), fork, supported CLI archive cleanup, and safe `config.toml` /
  `AGENTS.md` editing. Credentials, SQLite state, encrypted reasoning, and
  sandbox secrets are intentionally never exposed.
- **Universal command launcher** (`Ctrl+Shift+P`, `Ctrl+K`, or `F1`) for views,
  projects, current-session navigation, refresh, new sessions, resume, and help.
  `Ctrl+P` opens the project/session quick-open scope.
- **Quick launch** actions on Overview and project/session pages: start Claude in
  a project or resume a selected session directly in a new terminal.
- A complete, discoverable keyboard model with contextual shortcuts, pane
  cycling, tab cycling, filter/global search, rail toggle, and a searchable
  shortcut reference.
- **Context status** guidance using context pressure, compactions, and tool error
  rate, with focused `/compact` and start-fresh actions. Wall-clock duration alone
  is deliberately not treated as unhealthy.
- Fourteen regression tests covering both providers, deletion safety, atomic
  backups, path guards, launcher routing, identity, cumulative usage,
  root/subagent grouping, and incremental JSONL reading.
- A static browser preview with generated data for fast frontend development and
  visual review without access to a real Claude home.

### Changed
- Rebuilt the interface as a dense graphite developer workbench: one restrained
  accent, flatter surfaces, smaller radii, higher-contrast metadata, visible
  keyboard focus, a status bar, responsive breakpoints, and reduced-motion
  support.
- Renamed **Tune** to **Instructions** and made long Claude optimization work cancellable.
  Prompts now stream over stdin (avoiding Windows command-line limits), jobs have
  concurrency and timeout guards, and CLAUDE.md/memory writes create backups.
- Live refreshes are now path-aware and view-targeted. Expensive global aggregates
  are deferred outside Overview, refreshes cannot overlap, and continuous writes
  can no longer starve the trailing debounce.
- Prompt-history search is incrementally indexed in memory instead of rereading
  the full history file on every query. JSONL input is streamed line-by-line to
  avoid a duplicate whole-file buffer.
- Browser transcript growth is bounded during live tail-following; session-only
  scratchpad watches and large reconstructed detail state are released on exit.
- Cleanup renders large libraries in bounded chunks of 300 rows.
- Codex ChatGPT-plan usage is never combined into a dollar-spend claim. Claude
  pricing is labelled as an API-price estimate rather than a billing statement;
  capabilities that only exist in one agent are explicitly gated.

### Fixed
- Deletion is revalidated in the backend. Sessions with transcript activity in
  the last 10 minutes are conservatively protected, closing the gap where a quiet
  but still-running task could previously become deletable after two minutes.
- Settings, guidance, memory notes, and memory indexes use safer atomic writes;
  guidance and overwritten memory content are backed up first.
- Custom window controls are now shown only for the WSL workaround instead of
  duplicating native Windows controls.
- Clickable project/session/file rows are keyboard focusable, dialogs expose
  dialog semantics and initial focus, toasts are announced, and muted text now
  meets a substantially higher contrast target.

## [1.0.0] — 2026-07-18

First stable release. The app now covers the full lifecycle — explore, analyze,
tune and clean up — and ships as a single self-contained executable for Windows
and Linux.

### Added
- **Cleanup** — a disk-space helper that lists every session on the machine with
  its full on-disk footprint (transcript + tasks / file-history / image-cache /
  session-env). Multi-select by hand or with one-tap presets (empty, small talk,
  under 1¢, older than 30 days, largest 10), sort by size / age / cost, and
  delete in bulk (optionally purging ancillary data). Live sessions are
  protected from deletion. Select-to-delete is also available inside a project's
  session list.
- **Tune** — put your own signed-in `claude` CLI to work on your history,
  headless: **Refine CLAUDE.md** (global or per-project) folds durable
  conventions from recent sessions into a guidance file you review and save, and
  **Consolidate → memory** distills sessions into memory notes written to a
  project's memory store. Runs asynchronously so the UI never blocks; only
  session summaries are ever sent, never full transcripts.
- **Privacy-first settings** — a Privacy & data section with one-tap protections
  (keep sessions off claude.ai, master non-essential-traffic switch, disable
  telemetry / error reporting, drop the commit co-author trailer) and an **Apply
  privacy-first defaults** button.

### Changed
- **Settings redesigned** to be comprehensive but clean: a catalog of known
  settings, a dedicated environment-variable editor, and arbitrary custom
  key/value + env entries — so *any* setting is reachable. Only settings you
  actually set are written to `settings.json`; removing one prunes it (and any
  now-empty parent like `env`) so the file never accumulates dead keys.
- **Packaging is now single-file (onefile)**: one self-contained executable with
  no `_internal` folder beside it, a native splash screen during cold start, an
  app icon, and trimmed Qt modules for a smaller, faster-to-extract build.

## [0.4.0] — 2026-07-18

### Added
- **All-sessions Overview dashboard**: global spend (+avg/session), tokens,
  cache hit rate, prompts/turns/tool calls, subagent sessions, per-model cost,
  14-day activity, machine-wide tool usage and token composition.
- Application logo and icons — window/taskbar icon, Windows exe icon, favicon,
  in-app brand and README, all rendered from one SVG master.
- In-app minimize/close controls (WSLg title bars are nearly invisible).
- Per-model cost in the session model legend.
- PyInstaller entry point (`launcher.py`) and prebuilt release artifacts for
  Windows and Linux.

### Changed
- Monitor shows live state only (duplicated spend section removed) and every
  section/stat carries a plain-language explanation of what it is.
- The middle pane appears only inside a project — no duplicated project list.

### Fixed
- The filesystem watcher no longer crashes startup on unwatchable homes
  (e.g. UNC paths on Windows).

## [0.3.0] — 2026-07-18

### Changed
- **Transcripts are paged.** The backend now serves a small window of messages
  (the newest first) instead of serializing the whole reconstructed transcript;
  earlier pages load on demand and live sessions append only newly written
  events. Session payloads shrink from megabytes to kilobytes.
- **Analytics-first.** Opening a session lands on the Analytics tab.
- The live indicator is self-explanatory: steady green *watching*, amber
  *activity* while Claude Code writes to disk.

### Added
- Greatly expanded per-session analytics, all pre-aggregated server-side:
  cache hit rate, cost/output per turn, session duration, tool error counts
  and error rate, errors by tool, context compaction count, thinking share,
  hottest files (Read/Write/Edit targets), top shell commands, output tokens
  per turn, and activity-by-hour histogram — alongside the existing token
  composition, tokens by model, context-over-time and cumulative-cost charts.
- Subagent view is server-aggregated (Agent/Task invocations + sidechain
  messages) and independent of the loaded transcript window.
- CHANGELOG, CONTRIBUTING, and dummy-data documentation screenshots.

## [0.2.0] — 2026-07-18

### Added
- Global search across all session summaries and the prompt history, with
  jump-to-session.
- Image gallery (session image cache), workspace tab (scratchpad + background
  task outputs), shell snapshots and session environments in Monitor,
  file-history stats, copy-resume command, in-app file viewer.
- Settings as toggles/dropdowns writing to `settings.json`; in-app editor for
  small config files.

### Changed
- `orjson` decoding and incremental parsing: live sessions parse only appended
  bytes (~0.1 ms per refresh; cold 10 MB summary ≈ 40 ms). Statusline capture
  ticks refresh live meters without rescanning.

## [0.1.0] — 2026-07-18

### Added
- Initial release: project/session browser with cost and context meters,
  transcript viewer, analytics charts, memory manager with editing, task
  board, scratchpad browser, settings view, live filesystem watching, and the
  opt-in statusline capture hook. PySide6 + QtWebEngine, packaged with uv.
