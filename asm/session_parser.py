"""Streaming, *incremental* parser for Claude Code session ``.jsonl`` transcripts.

Performance model:

* ``orjson`` (Rust) is used when available — 5-10x faster than stdlib ``json``
  on the multi-megabyte transcripts Claude Code produces.
* Both the summary and the detail reconstruction are **builders** that can be
  fed records one at a time. The scanner keeps a builder + byte offset per
  file, so when an active session appends output only the *new* bytes are read
  and parsed — a live 100 MB session refreshes in microseconds instead of
  re-parsing the whole file.
* Appends are cut at the last complete newline so a partially-written trailing
  line is never consumed (it is picked up on the next refresh).

Assistant token usage is logged once per *content block* line but reflects the
whole API response, so usage is deduplicated by ``message.id`` — counting it per
line would multiply cost several-fold.
"""

from __future__ import annotations

import json as _stdjson
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

try:  # fast path
    import orjson as _orjson

    def _loads(data: bytes | str):
        return _orjson.loads(data)
except ImportError:  # pragma: no cover
    def _loads(data: bytes | str):
        return _stdjson.loads(data)

TEXT_TRUNCATE = 8000
PREVIEW_TRUNCATE = 600

#: A pause longer than this between two records is idle time, not work. Five
#: minutes is long enough that a slow tool call never counts as a break and
#: short enough that "went for lunch" is not billed as attention.
IDLE_GAP_MS = 5 * 60 * 1000


# --------------------------------------------------------------------------- #
# Low-level reading                                                            #
# --------------------------------------------------------------------------- #


def read_new_lines(path: Path, offset: int) -> tuple[list[bytes], int]:
    """Read complete lines appended after ``offset`` without a second full blob."""
    lines: list[bytes] = []
    new_offset = offset
    try:
        with path.open("rb") as fh:
            fh.seek(offset)
            while True:
                line = fh.readline()
                if not line or not line.endswith(b"\n"):
                    break
                lines.append(line[:-1])
                new_offset = fh.tell()
    except OSError:
        return [], offset
    return lines, new_offset


def iter_file_records(path: Path):
    """One full pass over a jsonl file (used where incremental state is absent)."""
    try:
        with path.open("rb") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    yield _loads(line)
                except Exception:
                    continue
    except OSError:
        return


# --------------------------------------------------------------------------- #
# Clock helpers, shared by both parsers                                        #
# --------------------------------------------------------------------------- #


def ts_ms(ts: Any) -> int:
    """An ISO-8601 stamp as epoch milliseconds; 0 when unusable."""
    if not ts:
        return 0
    try:
        return int(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, TypeError):
        return 0


def local_day(ms: int) -> str:
    """The local calendar day a moment falls on, as ``YYYY-MM-DD``."""
    return time.strftime("%Y-%m-%d", time.localtime(ms / 1000))


def local_slot(ms: int) -> str:
    """Weekday and hour in local time, as the ``"wday:hour"`` key a heatmap uses."""
    local = time.localtime(ms / 1000)
    return f"{local.tm_wday}:{local.tm_hour}"


class ActiveClock:
    """Wall-clock time spent working, with idle stretches left out.

    Every record with a timestamp advances the clock; the gap to the previous
    record counts as work only when it is shorter than :data:`IDLE_GAP_MS`.
    Anything longer is an idle stretch, which is kept so the UI can say when
    the session was paused rather than silently shrinking it.
    """

    __slots__ = ("active_ms", "idle", "_last")

    def __init__(self) -> None:
        self.active_ms = 0
        self.idle: list[list[int]] = []
        self._last = 0

    def tick(self, ms: int) -> None:
        if not ms:
            return
        if self._last and ms > self._last:
            gap = ms - self._last
            if gap <= IDLE_GAP_MS:
                self.active_ms += gap
            else:
                self.idle.append([self._last, ms])
                if len(self.idle) > 200:
                    self.idle.pop(0)
        if ms > self._last:
            self._last = ms


# --------------------------------------------------------------------------- #
# Shared helpers                                                               #
# --------------------------------------------------------------------------- #

from . import goals as goal_tracking  # noqa: E402
from . import pricing  # noqa: E402


def _usage_dict(u: pricing.Usage) -> dict:
    d = asdict(u)
    d["total"] = u.total
    return d


def _extract_usage(message: dict) -> pricing.Usage:
    u = message.get("usage") or {}
    return pricing.Usage(
        input=int(u.get("input_tokens") or 0),
        output=int(u.get("output_tokens") or 0),
        cache_read=int(u.get("cache_read_input_tokens") or 0),
        cache_write=int(u.get("cache_creation_input_tokens") or 0),
    )


def _context_tokens(message: dict) -> int:
    u = message.get("usage") or {}
    return (
        int(u.get("input_tokens") or 0)
        + int(u.get("cache_read_input_tokens") or 0)
        + int(u.get("cache_creation_input_tokens") or 0)
    )


def _first_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _looks_like_command(text: str) -> bool:
    t = text.lstrip()
    return t.startswith("<") or t.startswith("Caveat:") or t.startswith("[Request interrupted")


#: Tools that stop something the agent started: a background task or a shell.
KILL_TOOLS = ("TaskStop", "KillShell", "KillBash")
#: Tools that hand work to another agent.
AGENT_TOOLS = ("Agent", "Task", "Workflow")
TRACE_SUMMARY_CAP = 80    # events kept per session in the disk cache
TRACE_DETAIL_CAP = 400    # events kept for an open session


def slash_command(text: str) -> str:
    """The ``/name`` a user typed, when a user message is a slash command."""
    body = text.lstrip()
    if not body.startswith("<command-name>"):
        return ""
    end = body.find("</command-name>")
    if end < 0:
        return ""
    return body[len("<command-name>"):end].strip()[:60]


def is_interruption(text: str) -> bool:
    """A user record the CLI writes when you press Escape on a running turn."""
    return text.lstrip()[:60].startswith("[Request interrupted by user")


class Trace:
    """Notable moments in a session, in order: a skill invoked, an agent
    spawned, a task or shell killed, a turn interrupted, a command typed.

    Kept as a bounded list of compact rows so it can live in the summary
    cache for every session on the machine and be searched across projects.
    """

    __slots__ = ("rows", "cap", "counts")

    def __init__(self, cap: int) -> None:
        self.rows: list[dict] = []
        self.cap = cap
        self.counts: Counter[str] = Counter()

    def add(self, ms: int, kind: str, name: str, detail: str = "", ref: str = "") -> dict:
        row = {"t": ms, "k": kind, "n": name[:80]}
        if detail:
            row["d"] = detail[:120]
        if ref:
            row["id"] = ref
        self.rows.append(row)
        self.counts[kind] += 1
        if len(self.rows) > self.cap:
            self.rows.pop(0)
        return row

    def find(self, ref: str) -> dict | None:
        for row in reversed(self.rows):
            if row.get("id") == ref:
                return row
        return None


class DailyLedger:
    """Per-local-day totals: what a session cost and produced on each day.

    Kept compact because it is cached to disk for every session on the
    machine. Keys: ``c`` cost, ``t`` tokens, ``n`` turns, ``p`` prompts,
    ``e`` tool errors, ``a`` active milliseconds, ``m`` cost per model.
    """

    __slots__ = ("days", "priced")

    def __init__(self, *, priced: bool = True) -> None:
        self.days: dict[str, dict] = {}
        # Codex records tokens but proves nothing about billing, so its
        # ledger carries token counts and never a dollar figure.
        self.priced = priced

    def _bucket(self, day: str) -> dict:
        bucket = self.days.get(day)
        if bucket is None:
            bucket = {"c": 0.0, "t": 0, "n": 0, "p": 0, "e": 0, "a": 0, "m": {}}
            self.days[day] = bucket
        return bucket

    def turn(self, day: str, model: str, usage: pricing.Usage) -> None:
        bucket = self._bucket(day)
        cost = pricing.cost_for(usage, model) if self.priced and model and model != "unknown" else 0.0
        bucket["c"] += cost
        bucket["t"] += usage.total
        bucket["n"] += 1
        if cost:
            bucket["m"][model] = bucket["m"].get(model, 0.0) + cost

    def prompt(self, day: str) -> None:
        self._bucket(day)["p"] += 1

    def error(self, day: str) -> None:
        self._bucket(day)["e"] += 1

    def active(self, day: str, ms: int) -> None:
        if ms > 0:
            self._bucket(day)["a"] += ms

    def result(self) -> dict:
        out = {}
        for day, bucket in self.days.items():
            row = dict(bucket)
            row["c"] = round(row["c"], 6)
            row["m"] = {model: round(cost, 6) for model, cost in bucket["m"].items()}
            out[day] = row
        return out


# --------------------------------------------------------------------------- #
# Summary builder                                                              #
# --------------------------------------------------------------------------- #


@dataclass
class SessionSummary:
    session_id: str
    path: str
    cwd: str = ""
    git_branch: str = ""
    title: str = ""
    first_prompt: str = ""
    created: str = ""
    updated: str = ""
    user_messages: int = 0
    assistant_messages: int = 0
    tool_calls: int = 0
    models: list[str] = field(default_factory=list)
    usage: dict = field(default_factory=dict)
    usage_by_model: dict = field(default_factory=dict)
    cost: float = 0.0
    last_context_tokens: int = 0
    context_window: int = 0
    context_pct: float = 0.0
    has_subagents: bool = False
    subagent_calls: int = 0
    tool_counts: dict = field(default_factory=dict)
    size_bytes: int = 0
    mtime: float = 0.0
    # -- added for the dashboard: time, reliability, and per-day spend --
    active_ms: int = 0
    tool_errors: int = 0
    compactions: int = 0
    daily: dict = field(default_factory=dict)
    activity: dict = field(default_factory=dict)   # "wday:hour" -> turns
    # -- traceability: what was invoked, delegated, killed or interrupted --
    skills: dict = field(default_factory=dict)     # skill name -> invocations
    commands: dict = field(default_factory=dict)   # slash command -> uses
    agents: dict = field(default_factory=dict)     # subagent type -> spawns
    kills: int = 0
    interrupts: int = 0
    trace: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


class SummaryBuilder:
    """Aggregates summary stats; feed() records incrementally."""

    __slots__ = (
        "cwd", "git_branch", "title", "first_prompt", "created", "updated",
        "user_messages", "assistant_messages", "tool_calls", "models",
        "seen_ids", "total", "by_model", "tool_counts", "last_model",
        "last_context_tokens", "has_subagents", "subagent_calls",
        "tool_errors", "compactions", "_last_ctx", "clock", "ledger",
        "activity", "_day_active_last", "skills", "commands", "agents",
        "kills", "interrupts", "trace",
    )

    def __init__(self) -> None:
        self.cwd = ""
        self.git_branch = ""
        self.title = ""
        self.first_prompt = ""
        self.created = ""
        self.updated = ""
        self.user_messages = 0
        self.assistant_messages = 0
        self.tool_calls = 0
        self.models: list[str] = []
        self.seen_ids: set[str] = set()
        self.total = pricing.Usage()
        self.by_model: dict[str, pricing.Usage] = {}
        self.tool_counts: Counter[str] = Counter()
        self.last_model: str | None = None
        self.last_context_tokens = 0
        self.has_subagents = False
        self.subagent_calls = 0
        self.tool_errors = 0
        self.compactions = 0
        self._last_ctx = 0
        self.clock = ActiveClock()
        self.ledger = DailyLedger()
        self.activity: Counter[str] = Counter()
        self._day_active_last = 0
        self.skills: Counter[str] = Counter()
        self.commands: Counter[str] = Counter()
        self.agents: Counter[str] = Counter()
        self.kills = 0
        self.interrupts = 0
        self.trace = Trace(TRACE_SUMMARY_CAP)

    def _tick(self, ms: int) -> None:
        """Advance the work clock and charge the elapsed stretch to its day."""
        before = self.clock.active_ms
        self.clock.tick(ms)
        gained = self.clock.active_ms - before
        if gained:
            self.ledger.active(local_day(ms), gained)

    def feed(self, rec: dict) -> None:
        ts = rec.get("timestamp")
        ms = 0
        if ts:
            if not self.created:
                self.created = ts
            self.updated = ts
            ms = ts_ms(ts)
            self._tick(ms)
        if not self.cwd and rec.get("cwd"):
            self.cwd = rec["cwd"]
        if not self.git_branch and rec.get("gitBranch"):
            self.git_branch = rec["gitBranch"]
        if rec.get("isSidechain"):
            self.has_subagents = True

        rtype = rec.get("type")
        if rtype == "ai-title" and rec.get("aiTitle"):
            self.title = rec["aiTitle"]
            return

        message = rec.get("message")
        if not isinstance(message, dict):
            return
        role = message.get("role")

        if role == "user":
            content = message.get("content")
            is_tool_result = False
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        is_tool_result = True
                        if block.get("is_error"):
                            self.tool_errors += 1
                            if ms:
                                self.ledger.error(local_day(ms))
            if not is_tool_result:
                self.user_messages += 1
                if ms and not rec.get("isMeta") and not rec.get("isSidechain"):
                    self.ledger.prompt(local_day(ms))
                text = _first_text(content).strip()
                if text:
                    command = slash_command(text)
                    if command:
                        self.commands[command] += 1
                        self.trace.add(ms, "command", command)
                    elif is_interruption(text):
                        self.interrupts += 1
                        self.trace.add(ms, "interrupt", "interrupted")
                    elif not self.first_prompt and not _looks_like_command(text):
                        self.first_prompt = text[:280]

        elif role == "assistant":
            model = message.get("model")
            if model and model != "<synthetic>":
                if model not in self.models:
                    self.models.append(model)
                self.last_model = model

            for block in message.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    name = block.get("name", "?")
                    self.tool_counts[name] += 1
                    self.tool_calls += 1
                    inp = block.get("input") if isinstance(block.get("input"), dict) else {}
                    if name in AGENT_TOOLS:
                        self.subagent_calls += 1
                        kind = str(inp.get("subagent_type") or name)
                        self.agents[kind] += 1
                        self.trace.add(ms, "agent", kind, str(inp.get("description") or "")[:120])
                    elif name == "Skill":
                        skill = str(inp.get("skill") or "").strip()
                        if skill:
                            self.skills[skill] += 1
                            self.trace.add(ms, "skill", skill, str(inp.get("args") or "")[:120])
                    elif name in KILL_TOOLS:
                        self.kills += 1
                        self.trace.add(ms, "kill", name, str(inp.get("task_id") or inp.get("shell_id") or ""))

            ctx = _context_tokens(message)
            if ctx:
                self.last_context_tokens = ctx
            msg_id = message.get("id") or rec.get("requestId")
            if msg_id and msg_id not in self.seen_ids:
                self.seen_ids.add(msg_id)
                self.assistant_messages += 1
                u = _extract_usage(message)
                self.total.add(u)
                key = model or "unknown"
                self.by_model.setdefault(key, pricing.Usage()).add(u)
                if ctx:
                    if self._last_ctx and ctx < self._last_ctx * 0.65:
                        self.compactions += 1
                    self._last_ctx = ctx
                if ms:
                    self.ledger.turn(local_day(ms), key, u)
                    self.activity[local_slot(ms)] += 1

    def result(self, session_id: str, path: str, size: int, mtime: float) -> SessionSummary:
        s = SessionSummary(session_id=session_id, path=path, size_bytes=size, mtime=mtime)
        s.cwd = self.cwd
        s.git_branch = self.git_branch
        s.title = self.title
        s.first_prompt = self.first_prompt
        s.created = self.created
        s.updated = self.updated
        s.user_messages = self.user_messages
        s.assistant_messages = self.assistant_messages
        s.tool_calls = self.tool_calls
        s.models = list(self.models)
        s.usage = _usage_dict(self.total)
        s.usage_by_model = {m: _usage_dict(u) for m, u in self.by_model.items()}
        s.cost = sum(pricing.cost_for(u, m) for m, u in self.by_model.items())
        s.last_context_tokens = self.last_context_tokens
        s.context_window = pricing.context_window(self.last_model)
        if s.context_window:
            s.context_pct = round(100.0 * s.last_context_tokens / s.context_window, 1)
        s.has_subagents = self.has_subagents or self.subagent_calls > 0
        s.subagent_calls = self.subagent_calls
        s.tool_counts = dict(self.tool_counts.most_common(20))
        s.active_ms = self.clock.active_ms
        s.tool_errors = self.tool_errors
        s.compactions = self.compactions
        s.daily = self.ledger.result()
        s.activity = dict(self.activity)
        s.skills = dict(self.skills)
        s.commands = dict(self.commands)
        s.agents = dict(self.agents)
        s.kills = self.kills
        s.interrupts = self.interrupts
        s.trace = list(self.trace.rows)
        return s


def summarize(path: Path, *, size: int = 0, mtime: float = 0.0) -> SessionSummary:
    """Convenience one-shot full parse (non-incremental callers/tests)."""
    b = SummaryBuilder()
    for rec in iter_file_records(path):
        b.feed(rec)
    return b.result(path.stem, str(path), size, mtime)


# --------------------------------------------------------------------------- #
# Detail builder                                                               #
# --------------------------------------------------------------------------- #


def _condense_block(block: dict) -> dict | None:
    btype = block.get("type")
    if btype == "text":
        text = block.get("text", "")
        return {"type": "text", "text": text[:TEXT_TRUNCATE], "truncated": len(text) > TEXT_TRUNCATE}
    if btype == "thinking":
        text = block.get("thinking", "")
        return {"type": "thinking", "text": text[:TEXT_TRUNCATE], "truncated": len(text) > TEXT_TRUNCATE}
    if btype == "tool_use":
        raw = _stdjson.dumps(block.get("input", {}), ensure_ascii=False, default=str)
        return {
            "type": "tool_use",
            "id": block.get("id"),
            "name": block.get("name", "?"),
            "input_preview": raw[:PREVIEW_TRUNCATE],
            "input_truncated": len(raw) > PREVIEW_TRUNCATE,
        }
    if btype == "tool_result":
        content = block.get("content")
        text = content if isinstance(content, str) else _first_text(content)
        if not text and isinstance(content, list):
            text = _stdjson.dumps(content, ensure_ascii=False, default=str)
        return {
            "type": "tool_result",
            "tool_use_id": block.get("tool_use_id"),
            "content_preview": (text or "")[:PREVIEW_TRUNCATE],
            "content_truncated": len(text or "") > PREVIEW_TRUNCATE,
            "is_error": bool(block.get("is_error")),
        }
    if btype == "image":
        return {"type": "image"}
    return {"type": btype or "unknown"}


_READ_TOOLS = ("Read", "NotebookRead")
_EDIT_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")
_FILE_TOOLS = _READ_TOOLS + _EDIT_TOOLS


def _downsample(seq: list, cap: int = 300) -> list:
    if len(seq) <= cap:
        return list(seq)
    step = len(seq) / cap
    return [seq[int(i * step)] for i in range(cap)]


def _clean(e: dict) -> dict:
    return {k: v for k, v in e.items() if k != "_merge_id"}


def _command_key(command: str) -> str:
    """The shape of a shell command, for spotting the ones that get re-run."""
    flat = " ".join(command.split())
    return flat[:120]


class DetailBuilder:
    """Reconstructs the transcript + rich analytics; feed() incrementally.

    The full event list stays in memory but is *never* serialized whole — the
    scanner serves paged windows over it, and everything chart-shaped is
    pre-aggregated here so every tab's payload stays small and O(window).
    """

    def __init__(self) -> None:
        self.events: list[dict] = []
        self.seen_ids: set[str] = set()
        self.total = pricing.Usage()
        self.by_model: dict[str, pricing.Usage] = {}
        self.tool_counts: Counter[str] = Counter()
        self.timeline: list[dict] = []
        # The arc of the session at both levels: real /goal runs, and the
        # prompts that ran inside them (see asm/goals.py).
        self.arc = goal_tracking.SessionArc()
        # analytics aggregates
        self.user_prompts = 0
        self.tool_errors: Counter[str] = Counter()
        self.tool_error_total = 0
        self._tool_id_name: dict[str, str] = {}
        self.files_touched: Counter[str] = Counter()
        self.file_reads: Counter[str] = Counter()
        self.file_edits: Counter[str] = Counter()
        self.bash_commands: Counter[str] = Counter()
        self.command_repeats: Counter[str] = Counter()
        self.thinking_chars = 0
        self.text_chars = 0
        self.output_per_turn: list[int] = []
        self.hourly = [0] * 24
        self.daily: Counter[str] = Counter()
        self.compactions = 0
        self.compaction_marks: list[dict] = []
        self._last_ctx = 0
        self.peak_ctx = 0
        self.first_ts = ""
        self.last_ts = ""
        self.clock = ActiveClock()
        # traceability: skills, agents, kills, interruptions, commands
        self.trace = Trace(TRACE_DETAIL_CAP)
        self.skills: Counter[str] = Counter()
        self.agents: Counter[str] = Counter()
        self.commands: Counter[str] = Counter()
        self.kills = 0
        self.interrupts = 0
        # subagents
        self.sidechain_count = 0
        self.sidechain_events: list[dict] = []  # refs into self.events, capped
        self.agent_calls: list[dict] = []

    def _clock(self, ts: str | None) -> None:
        if not ts:
            return
        if not self.first_ts:
            self.first_ts = ts
        self.last_ts = ts
        ms = ts_ms(ts)
        if ms:
            self.clock.tick(ms)
            local = time.localtime(ms / 1000)
            self.hourly[local.tm_hour] += 1
            self.daily[time.strftime("%Y-%m-%d", local)] += 1

    def _track_sidechain(self, event: dict) -> None:
        self.sidechain_count += 1
        self.sidechain_events.append(event)
        if len(self.sidechain_events) > 100:
            self.sidechain_events.pop(0)

    def feed(self, rec: dict) -> None:
        # /goal events arrive as `goal_status` attachments with no message at
        # all, so they are offered to the arc before anything message-shaped.
        if self.arc.feed_record(rec):
            self._clock(rec.get("timestamp"))
            return
        message = rec.get("message")
        if not isinstance(message, dict):
            return
        role = message.get("role")
        ts = rec.get("timestamp")
        is_side = bool(rec.get("isSidechain"))
        # `isMeta` marks text the CLI injected into the user role — the Stop
        # hook directive above all. Nobody typed it, so it is not a request.
        is_meta = bool(rec.get("isMeta"))

        if role == "assistant":
            model = message.get("model")
            raw_blocks = message.get("content") or []
            blocks = []
            for raw in raw_blocks:
                b = _condense_block(raw) if isinstance(raw, dict) else None
                if not b:
                    continue
                blocks.append(b)
                btype = b["type"]
                if btype == "tool_use":
                    name = b["name"]
                    self.tool_counts[name] += 1
                    self.arc.tool(name, ts or "", b.get("id") or "")
                    if b.get("id"):
                        self._tool_id_name[b["id"]] = name
                    inp = raw.get("input") if isinstance(raw.get("input"), dict) else {}
                    if name in _FILE_TOOLS:
                        fp = inp.get("file_path") or inp.get("path") or inp.get("notebook_path")
                        if fp:
                            self.files_touched[str(fp)] += 1
                            if name in _READ_TOOLS:
                                self.file_reads[str(fp)] += 1
                            else:
                                self.file_edits[str(fp)] += 1
                            self.arc.file(str(fp))
                    elif name == "Bash":
                        cmd = str(inp.get("command", "")).strip()
                        if cmd:
                            self.bash_commands[cmd.split()[0][:40]] += 1
                            self.command_repeats[_command_key(cmd)] += 1
                            self.arc.command(cmd.split()[0][:40])
                    elif name in AGENT_TOOLS:
                        desc = inp.get("description") or inp.get("prompt") or ""
                        kind = str(inp.get("subagent_type") or name)
                        self.agent_calls.append({"name": name, "kind": kind, "desc": str(desc)[:160], "ts": ts})
                        if len(self.agent_calls) > 100:
                            self.agent_calls.pop(0)
                        self.agents[kind] += 1
                        self.trace.add(ts_ms(ts), "agent", kind, str(desc)[:120], b.get("id") or "")
                    elif name == "Skill":
                        skill = str(inp.get("skill") or "").strip()
                        if skill:
                            self.skills[skill] += 1
                            self.trace.add(ts_ms(ts), "skill", skill, str(inp.get("args") or "")[:120], b.get("id") or "")
                    elif name in KILL_TOOLS:
                        self.kills += 1
                        self.trace.add(ts_ms(ts), "kill", name, str(inp.get("task_id") or inp.get("shell_id") or ""), b.get("id") or "")
                elif btype == "thinking":
                    self.thinking_chars += len(b.get("text", ""))
                    self.arc.thinking(len(b.get("text", "")), ts or "")
                elif btype == "text":
                    self.text_chars += len(b.get("text", ""))
                    self.arc.text(len(b.get("text", "")), ts or "")

            msg_id = message.get("id") or rec.get("requestId")
            last = self.events[-1] if self.events else None
            if last is not None and last.get("_merge_id") == msg_id and last["role"] == "assistant":
                last["blocks"].extend(blocks)
            else:
                event = {
                    "uuid": rec.get("uuid"),
                    "role": "assistant",
                    "ts": ts,
                    "model": model,
                    "sidechain": is_side,
                    "blocks": blocks,
                    "_merge_id": msg_id,
                }
                self.events.append(event)
                self._clock(ts)
                if is_side:
                    self._track_sidechain(event)

            if msg_id and msg_id not in self.seen_ids:
                self.seen_ids.add(msg_id)
                u = _extract_usage(message)
                self.total.add(u)
                self.by_model.setdefault(model or "unknown", pricing.Usage()).add(u)
                self.output_per_turn.append(u.output)
                self.arc.turn(ts or "", model or "", u)
                ctx = _context_tokens(message)
                if ctx:
                    if self._last_ctx and ctx < self._last_ctx * 0.65:
                        self.compactions += 1
                        self.arc.compaction()
                        self.compaction_marks.append({"t": ts, "from": self._last_ctx, "to": ctx})
                        self.trace.add(ts_ms(ts), "compaction", "compacted",
                                       f"{self._last_ctx} -> {ctx} tokens")
                    self._last_ctx = ctx
                    if ctx > self.peak_ctx:
                        self.peak_ctx = ctx
                    if ts:
                        cost = sum(pricing.cost_for(v, m) for m, v in self.by_model.items())
                        self.timeline.append({"t": ts, "ctx": ctx, "cost": round(cost, 4)})

        elif role == "user":
            content = message.get("content")
            has_tool_result = False
            if isinstance(content, str):
                blocks = [{"type": "text", "text": content[:TEXT_TRUNCATE], "truncated": len(content) > TEXT_TRUNCATE}]
            elif isinstance(content, list):
                blocks = []
                for raw in content:
                    b = _condense_block(raw) if isinstance(raw, dict) else None
                    if not b:
                        continue
                    blocks.append(b)
                    if b["type"] == "tool_result":
                        has_tool_result = True
                        failed = bool(b.get("is_error"))
                        call_id = b.get("tool_use_id") or ""
                        if failed:
                            self.tool_error_total += 1
                            name = self._tool_id_name.get(call_id, "?")
                            self.tool_errors[name] += 1
                        # Reported for every result, not only failures: this is
                        # when the call finished, which is how long it took.
                        self.arc.tool_result(call_id, ts or "", is_error=failed)
                        if call_id and self._tool_id_name.get(call_id) in AGENT_TOOLS + ("Skill",) + KILL_TOOLS:
                            row = self.trace.find(call_id)
                            if row is not None:
                                finished = ts_ms(ts)
                                if finished and row["t"] and finished > row["t"]:
                                    row["ms"] = finished - row["t"]
                                if failed:
                                    row["e"] = True
            else:
                blocks = []
            if not has_tool_result:
                self.user_prompts += 1
                prompt = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
                if not is_side and not is_meta:
                    command = slash_command(prompt)
                    if command:
                        self.commands[command] += 1
                        self.trace.add(ts_ms(ts), "command", command)
                    elif is_interruption(prompt):
                        self.interrupts += 1
                        self.trace.add(ts_ms(ts), "interrupt", "interrupted")
                    self.arc.begin(prompt, ts or "")
            else:
                self.arc.touch(ts or "")
            event = {
                "uuid": rec.get("uuid"),
                "role": "user",
                "ts": ts,
                "sidechain": is_side,
                "blocks": blocks,
            }
            self.events.append(event)
            self._clock(ts)
            if is_side:
                self._track_sidechain(event)

    # -- output ------------------------------------------------------------- #

    def meta(self) -> dict:
        """Everything except transcript events — small, chart-ready payload."""
        daily = sorted(self.daily.items())
        by_model = {}
        for m, u in self.by_model.items():
            d = _usage_dict(u)
            d["cost"] = round(pricing.cost_for(u, m), 4)
            by_model[m] = d
        last_model = next(reversed(self.by_model), None) if self.by_model else None
        window = pricing.context_window(last_model)
        repeats = {cmd: n for cmd, n in self.command_repeats.most_common(8) if n > 1}
        return {
            "total_events": len(self.events),
            "usage": _usage_dict(self.total),
            "usage_by_model": by_model,
            "cost": round(sum(pricing.cost_for(u, m) for m, u in self.by_model.items()), 4),
            "cache_savings": round(sum(pricing.cache_savings(u.cache_read, m) for m, u in self.by_model.items()), 4),
            "tool_counts": dict(self.tool_counts.most_common()),
            "timeline": _downsample(self.timeline),
            "context_window": window,
            "last_context_tokens": self._last_ctx,
            "peak_context_tokens": self.peak_ctx,
            "context_pct": round(100.0 * self._last_ctx / window, 1) if window else 0.0,
            **self.arc.result(self.last_ts),
            "analytics": {
                "user_prompts": self.user_prompts,
                "assistant_turns": len(self.seen_ids),
                "tool_calls": sum(self.tool_counts.values()),
                "tool_error_total": self.tool_error_total,
                "tool_errors": dict(self.tool_errors.most_common(10)),
                "files_touched": dict(self.files_touched.most_common(15)),
                "file_reads": dict(self.file_reads.most_common(15)),
                "file_edits": dict(self.file_edits.most_common(15)),
                "bash_commands": dict(self.bash_commands.most_common(12)),
                "command_repeats": repeats,
                "thinking_chars": self.thinking_chars,
                "text_chars": self.text_chars,
                "output_per_turn": _downsample(self.output_per_turn),
                "hourly": list(self.hourly),
                "daily": daily[-30:],
                "compactions": self.compactions,
                "compaction_marks": list(self.compaction_marks[-20:]),
                "first_ts": self.first_ts,
                "last_ts": self.last_ts,
                "active_ms": self.clock.active_ms,
                "idle": [list(gap) for gap in self.clock.idle[-40:]],
            },
            "subagents": {
                "count": self.sidechain_count,
                "agent_calls": list(self.agent_calls),
                "events": [_clean(e) for e in self.sidechain_events],
            },
            "trace": {
                "events": list(self.trace.rows),
                "skills": dict(self.skills),
                "agents": dict(self.agents),
                "commands": dict(self.commands),
                "kills": self.kills,
                "interrupts": self.interrupts,
            },
        }

    def tail(self, count: int) -> tuple[list[dict], int]:
        """Last `count` events; returns (events, global index of the first one)."""
        tail = self.events[-count:] if count else []
        start = len(self.events) - len(tail)
        return [_clean(e) for e in tail], start

    def page_before(self, before: int, count: int) -> tuple[list[dict], int]:
        """Up to `count` events with global index < before."""
        lo = max(0, before - count)
        return [_clean(e) for e in self.events[lo:before]], lo

    def page_after(self, after: int) -> tuple[list[dict], int]:
        """All events with global index > after (used for live tail-follow)."""
        start = after + 1
        return [_clean(e) for e in self.events[start:]], start


def detail(path: Path, *, tail: int = 4000) -> dict:
    """Convenience one-shot full parse (non-incremental callers/tests)."""
    b = DetailBuilder()
    for rec in iter_file_records(path):
        b.feed(rec)
    out = b.meta()
    out["events"], out["events_start"] = b.tail(tail)
    return out
