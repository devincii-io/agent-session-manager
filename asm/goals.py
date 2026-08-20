"""The arc of a session, at the two levels a person actually thinks in.

**Goals** are Claude Code's ``/goal`` directives: a session-scoped Stop hook
with a condition, which blocks the agent from stopping until that condition
holds. A goal has a real beginning (you set it), a real end (it was met, you
replaced it, or the session ended with it still open), and a measurable middle.

**Requests** are the individual prompts you sent. While a goal is active they
are follow-ups *inside* it — you steering something already running — which is
why they are tracked separately and rolled up into the goal that was open.

Both are reconstructed incrementally, exactly like the summary and detail
builders around them, so a live session appends instead of re-deriving.

The goal records come from the transcript's own ``goal_status`` attachments::

    {"type": "goal_status", "met": false, "sentinel": true, "condition": "…"}
    {"type": "goal_status", "met": false, "condition": "…", "reason": "…"}
    {"type": "goal_status", "met": true,  "condition": "…", "reason": "…"}

The first is the goal being set. The second is the hook refusing a stop, with
its reasoning — the checkpoints along the way. The third is the goal being met,
which ends it.
"""

from __future__ import annotations

from datetime import datetime

from . import pricing

# Categories, not tool names. A timeline lane per tool name would have forty
# lanes and say nothing; six kinds of work read at a glance. Names are matched
# case-insensitively against this table first, then by prefix rules below.
_CATEGORY_BY_NAME = {
    # reading the world
    "read": "read", "notebookread": "read", "view": "read", "read_file": "read",
    "ls": "read", "list_dir": "read", "cat": "read",
    # finding things in it
    "grep": "search", "glob": "search", "search": "search", "find": "search",
    "codebase_search": "search", "file_search": "search", "ripgrep": "search",
    # changing it
    "edit": "edit", "multiedit": "edit", "write": "edit", "notebookedit": "edit",
    "apply_patch": "edit", "str_replace_editor": "edit", "create_file": "edit",
    # running it
    "bash": "exec", "bashoutput": "exec", "killshell": "exec", "killbash": "exec",
    "powershell": "exec", "exec": "exec", "shell": "exec", "shell_command": "exec",
    "local_shell_call": "exec", "run_terminal_cmd": "exec", "container_exec": "exec",
    # the network
    "websearch": "web", "webfetch": "web", "web_search": "web", "web_fetch": "web",
    "browser": "web", "fetch": "web",
    # delegating
    "agent": "agent", "task": "agent", "workflow": "agent", "spawn_agent": "agent",
    "send_message": "agent", "sendmessage": "agent", "followup_task": "agent",
    "subagent": "agent",
    # planning out loud, and the tools that steer a run rather than do work
    "todowrite": "plan", "todoread": "plan", "update_plan": "plan",
    "exitplanmode": "plan", "enterplanmode": "plan", "plan": "plan",
    "skill": "plan", "slashcommand": "plan", "reportfindings": "plan",
    "croncreate": "plan", "cronlist": "plan", "crondelete": "plan",
    "schedulewakeup": "plan", "taskcreate": "plan", "taskupdate": "plan",
    "taskread": "plan", "todo": "plan",
    # more of the same kinds under different names
    "toolsearch": "search", "listmcpresourcestool": "search",
    "readmcpresourcetool": "read", "artifact": "edit", "notebook": "edit",
    "taskoutput": "agent", "taskstop": "agent", "monitor": "exec",
    # turning the conversation back to the human
    "askuserquestion": "ask", "ask_user": "ask", "request_input": "ask",
    "askuser": "ask", "elicit": "ask",
}

#: Display order and labels for the categories, consumed by the frontend legend.
CATEGORIES = ("read", "search", "edit", "exec", "web", "agent", "plan", "ask", "mcp", "other")

MAX_REQUESTS = 400       # a session with more prompts than this keeps the newest
MAX_STEPS = 240          # per request; enough to draw a dense lane, bounded payload
MAX_GOALS = 40           # /goal is set by hand; more than this is not a real session
MAX_CHECKS = 60          # stop-hook evaluations kept per goal
MAX_PENDING_CALLS = 4000
PROMPT_PREVIEW = 260
CONDITION_PREVIEW = 400
REASON_PREVIEW = 600

# A single tool call is not allowed to claim more than this much wall clock.
# Without it, one call whose result was never written (an interrupted session)
# would absorb the rest of the transcript.
MAX_CALL_MS = 60 * 60 * 1000


def categorize(name: str) -> str:
    """Map a tool name onto one of :data:`CATEGORIES`."""
    if not name:
        return "other"
    lowered = str(name).strip().lower()
    known = _CATEGORY_BY_NAME.get(lowered)
    if known:
        return known
    if lowered.startswith("mcp__") or lowered.startswith("mcp."):
        return "mcp"
    # Heuristics for tools this build has never seen — an unknown `foo_search`
    # still belongs beside the other searches rather than in a junk drawer.
    for needle, category in (
        ("question", "ask"), ("search", "search"), ("grep", "search"),
        ("write", "edit"), ("edit", "edit"), ("patch", "edit"),
        ("read", "read"), ("shell", "exec"), ("bash", "exec"), ("exec", "exec"),
        ("fetch", "web"), ("http", "web"), ("agent", "agent"), ("plan", "plan"),
    ):
        if needle in lowered:
            return category
    return "other"


# Wrappers the CLI writes into the user role that no person typed: command
# echoes, captured stdout, injected reminders. They must not open a request, or
# a session's arc becomes a list of plumbing with the real prompts buried in it.
# The Stop-hook directive is here for the same reason — it *is* the goal, and it
# is tracked as one; it is not something you asked for.
_NOISE_PREFIXES = (
    # Claude Code
    "<local-command-caveat", "<local-command-stdout", "<local-command-stderr",
    "<command-message", "<command-args", "<system-reminder",
    "<bash-input", "<bash-stdout", "<bash-stderr", "caveat:",
    "[request interrupted", "<user-prompt-submit-hook", "<task-notification",
    "a session-scoped stop hook is now active",
    "this session is being continued from a previous conversation",
    # Codex
    "<environment_context", "<user_instructions", "<recommended_plugins",
    "<instructions", "# agents.md instructions", "# files mentioned by the user",
)


def classify_prompt(text: str) -> tuple[str, str]:
    """Return ``(kind, display_text)`` for a user message.

    ``kind`` is ``"prompt"`` for something a person typed, ``"command"`` for a
    slash command, and ``"noise"`` for CLI scaffolding that only looks like a
    user turn.
    """
    body = (text or "").strip()
    if not body:
        return "prompt", ""
    lowered = body.lower()

    # A slash command is a real user action even when it arrives wrapped in
    # <command-name> markup, so it is recovered before the noise check below.
    start = body.find("<command-name>")
    if start >= 0:
        end = body.find("</command-name>", start)
        if end > start:
            name = body[start + len("<command-name>"):end].strip()
            if name:
                return "command", name[:PROMPT_PREVIEW]

    if lowered.startswith(_NOISE_PREFIXES):
        return "noise", ""

    lines = [line.strip() for line in body.splitlines() if line.strip()]
    return "prompt", " ".join(lines)[:PROMPT_PREVIEW]


def epoch_ms(ts: str) -> int:
    """An ISO-8601 stamp as epoch milliseconds; 0 when unusable."""
    if not ts:
        return 0
    try:
        return int(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def span_ms(start: str, end: str) -> int:
    """Milliseconds between two ISO-8601 stamps; 0 when either is unusable."""
    a, b = epoch_ms(start), epoch_ms(end)
    if not a or not b:
        return 0
    return b - a if b > a else 0


def _median(values: list[int]) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) // 2


class Spans:
    """Wall-clock time per category, counting overlap only once.

    Agents run tools in parallel, so adding up call durations overstates time
    badly — three greps at once are not three grep-minutes. Each category keeps
    the union of its intervals instead. Calls arrive in roughly chronological
    order, so merging against the last open interval is enough and costs
    nothing per call.

    Categories can still overlap *each other* (a read during a shell command),
    so the per-category figures deliberately do not sum to the session length.
    """

    __slots__ = ("_open", "ms")

    def __init__(self) -> None:
        self._open: dict[str, list[int]] = {}
        self.ms: dict[str, int] = {}

    def add(self, category: str, start: int, end: int) -> None:
        if not start or end <= start:
            return
        end = min(end, start + MAX_CALL_MS)
        current = self._open.get(category)
        if current is not None and start <= current[1]:
            if end > current[1]:
                self.ms[category] = self.ms.get(category, 0) + (end - current[1])
                current[1] = end
            return
        self._open[category] = [start, end]
        self.ms[category] = self.ms.get(category, 0) + (end - start)

    def result(self) -> dict[str, int]:
        return {category: value for category, value in self.ms.items() if value > 0}

    @property
    def total(self) -> int:
        return sum(self.ms.values())


# --------------------------------------------------------------------------- #
# requests: one per prompt                                                     #
# --------------------------------------------------------------------------- #


class Request:
    """One user prompt and everything that happened until the next one."""

    __slots__ = (
        "index", "prompt", "start", "end", "turns", "steps", "by_cat",
        "errors", "error_names", "subagents", "asked", "files", "commands",
        "usage_by_model", "output_tokens", "thinking_chars", "text_chars",
        "models", "first_response", "dropped_steps", "compactions", "priced",
        "kind", "spans",
    )

    def __init__(self, index: int, prompt: str, ts: str) -> None:
        self.index = index
        self.prompt = prompt
        self.start = ts
        self.end = ts
        self.turns = 0
        self.steps: list[dict] = []
        self.by_cat: dict[str, int] = {}
        self.errors = 0
        self.error_names: dict[str, int] = {}
        self.subagents = 0
        self.asked = False
        self.files: dict[str, int] = {}
        self.commands: dict[str, int] = {}
        self.usage_by_model: dict[str, pricing.Usage] = {}
        self.output_tokens = 0
        self.thinking_chars = 0
        self.text_chars = 0
        self.models: list[str] = []
        self.first_response = ""
        self.dropped_steps = 0
        self.compactions = 0
        self.spans = Spans()
        # Codex records tokens but proves nothing about billing, so its
        # requests carry token counts and no dollar figure at all.
        self.priced = True
        self.kind = "prompt"

    # -- accumulation ------------------------------------------------------- #

    def touch(self, ts: str) -> None:
        if ts and ts > self.end:
            self.end = ts

    def add_tool(self, name: str, category: str, ts: str, call_id: str = "") -> None:
        self.by_cat[category] = self.by_cat.get(category, 0) + 1
        if category == "ask":
            self.asked = True
        if category == "agent":
            self.subagents += 1
        if len(self.steps) < MAX_STEPS:
            step = {"t": ts or self.end, "c": category, "n": str(name)[:48]}
            if call_id:
                step["id"] = call_id
            self.steps.append(step)
        else:
            self.dropped_steps += 1
        self.touch(ts)

    def close_call(self, call_id: str, category: str, start: int, end: int) -> None:
        self.spans.add(category, start, end)
        if call_id:
            for step in reversed(self.steps):
                if step.get("id") == call_id:
                    step["ms"] = max(0, min(end - start, MAX_CALL_MS))
                    break

    def mark_error(self, call_id: str, name: str = "") -> None:
        self.errors += 1
        label = name or "?"
        if call_id:
            for step in reversed(self.steps):
                if step.get("id") == call_id:
                    step["e"] = True
                    label = step.get("n") or label
                    break
        self.error_names[label] = self.error_names.get(label, 0) + 1

    def add_turn(self, ts: str, model: str, usage: pricing.Usage | None) -> None:
        self.turns += 1
        if not self.first_response and ts:
            self.first_response = ts
        if model and model not in self.models:
            self.models.append(model)
        if usage is not None:
            bucket = self.usage_by_model.setdefault(model or "unknown", pricing.Usage())
            bucket.add(usage)
            self.output_tokens += usage.output
        self.touch(ts)

    # -- output ------------------------------------------------------------- #

    @property
    def tool_calls(self) -> int:
        return sum(self.by_cat.values())

    def _outcome(self) -> str:
        """How the request ended, in the terms a person would use."""
        if self.asked:
            return "question"
        if not self.turns and not self.tool_calls and not self.text_chars:
            return "empty"
        calls = self.tool_calls
        if self.errors and (calls == 0 or self.errors / max(1, calls) >= 0.34):
            return "error"
        if self.errors:
            return "recovered"
        return "done"

    def to_dict(self) -> dict:
        cost = sum(pricing.cost_for(u, m) for m, u in self.usage_by_model.items()) if self.priced else 0.0
        total = sum(u.total for u in self.usage_by_model.values())
        return {
            "i": self.index,
            "kind": self.kind,
            "prompt": self.prompt,
            "start": self.start,
            "end": self.end,
            "first_response": self.first_response,
            "ms": span_ms(self.start, self.end),
            "latency_ms": span_ms(self.start, self.first_response),
            "turns": self.turns,
            "tools": self.tool_calls,
            "by_cat": dict(self.by_cat),
            "cat_ms": self.spans.result(),
            "tool_ms": self.spans.total,
            "steps": list(self.steps),
            "dropped_steps": self.dropped_steps,
            "errors": self.errors,
            "error_names": dict(sorted(self.error_names.items(), key=lambda kv: -kv[1])[:5]),
            "subagents": self.subagents,
            "asked": self.asked,
            "compactions": self.compactions,
            "files": [name for name, _ in sorted(self.files.items(), key=lambda kv: -kv[1])[:6]],
            "commands": [name for name, _ in sorted(self.commands.items(), key=lambda kv: -kv[1])[:6]],
            "tokens": total,
            "output_tokens": self.output_tokens,
            "cost": round(cost, 4),
            "models": list(self.models),
            "thinking_chars": self.thinking_chars,
            "text_chars": self.text_chars,
            "outcome": self._outcome(),
        }


class RequestTracker:
    """Incremental per-prompt segmentation, shared by both parsers."""

    def __init__(self, *, priced: bool = True) -> None:
        self.requests: list[Request] = []
        self.priced = priced
        self.dropped = 0
        self._counter = 0
        self.spans = Spans()

    def begin(self, prompt: str, ts: str) -> str:
        """Start a request for a real user prompt; returns its kind."""
        kind, cleaned = classify_prompt(prompt)
        if kind == "noise":
            # Scaffolding, not a request. Whatever follows still belongs to the
            # request that is already open.
            self.touch(ts)
            return kind
        request = Request(self._counter, cleaned, ts or "")
        request.priced = self.priced
        request.kind = kind
        self._counter += 1
        self.requests.append(request)
        if len(self.requests) > MAX_REQUESTS:
            # Keep the newest window; the frontend is told how many were dropped
            # so it never presents a truncated arc as the whole session.
            self.dropped += 1
            self.requests.pop(0)
        return kind

    @property
    def current(self) -> Request | None:
        return self.requests[-1] if self.requests else None

    def ensure(self, ts: str) -> Request:
        """Somewhere to attribute work when a session starts mid-stream.

        A resumed session, or one whose first user record is CLI scaffolding,
        does work before any prompt this tracker recognises. That work is real
        and is kept — under a request marked ``implicit`` so the UI can say what
        it is instead of showing an empty prompt.
        """
        request = self.current
        if request is None:
            request = Request(self._counter, "", ts or "")
            request.priced = self.priced
            request.kind = "implicit"
            self._counter += 1
            self.requests.append(request)
        return request

    def by_index(self, index: int) -> Request | None:
        for request in reversed(self.requests):
            if request.index == index:
                return request
        return None

    def touch(self, ts: str) -> None:
        request = self.current
        if request is not None:
            request.touch(ts)

    # -- output ------------------------------------------------------------- #

    def result(self) -> dict:
        requests = [request.to_dict() for request in self.requests]
        active = [item for item in requests if item["tools"] or item["turns"]]
        by_cat: dict[str, int] = {}
        for item in requests:
            for category, count in item["by_cat"].items():
                by_cat[category] = by_cat.get(category, 0) + count
        return {
            "requests": requests,
            "dropped": self.dropped,
            "count": self._counter,
            "by_cat": by_cat,
            "cat_ms": self.spans.result(),
            "tool_ms": self.spans.total,
            "total_ms": sum(item["ms"] for item in active),
            "median_ms": _median([item["ms"] for item in active]),
            "priced": self.priced,
            "questions": sum(1 for item in requests if item["asked"]),
            "failed": sum(1 for item in requests if item["outcome"] == "error"),
            "categories": list(CATEGORIES),
        }


# --------------------------------------------------------------------------- #
# goals: Claude Code's /goal stop hook                                          #
# --------------------------------------------------------------------------- #


class GoalRun:
    """One ``/goal`` directive, from the moment it was set until it ended."""

    __slots__ = ("index", "condition", "start", "end", "met", "superseded",
                 "checks", "dropped_checks", "follow_ups", "commands", "turns",
                 "by_cat", "errors", "asked", "subagents", "compactions",
                 "usage_by_model", "priced", "files", "spans", "request_ids")

    def __init__(self, index: int, condition: str, ts: str, *, priced: bool = True) -> None:
        self.index = index
        self.condition = condition
        self.start = ts
        self.end = ""
        self.met = False
        self.superseded = False
        self.checks: list[dict] = []
        self.dropped_checks = 0
        # everything that happened while it was open
        self.follow_ups = 0
        self.commands = 0
        self.turns = 0
        self.by_cat: dict[str, int] = {}
        self.errors = 0
        self.asked = 0
        self.subagents = 0
        self.compactions = 0
        self.usage_by_model: dict[str, pricing.Usage] = {}
        self.files: set[str] = set()
        self.spans = Spans()
        self.request_ids: list[int] = []
        self.priced = priced

    @property
    def open(self) -> bool:
        return not self.end

    def add_check(self, met: bool, reason: str, ts: str) -> None:
        if len(self.checks) < MAX_CHECKS:
            self.checks.append({"t": ts, "met": met, "reason": (reason or "")[:REASON_PREVIEW]})
        else:
            self.dropped_checks += 1

    def close(self, ts: str, *, met: bool, superseded: bool = False) -> None:
        self.end = ts or self.end
        self.met = met
        self.superseded = superseded

    def status(self) -> str:
        if self.met:
            return "met"
        if self.superseded:
            return "superseded"
        if self.open:
            return "open"
        return "ended"

    @property
    def tool_calls(self) -> int:
        return sum(self.by_cat.values())

    def to_dict(self, last_ts: str = "") -> dict:
        # An open goal is measured to the last thing that happened in the
        # session, and labelled open — never quietly closed at the last event.
        end = self.end or last_ts
        blocked = [check for check in self.checks if not check["met"]]
        cost = sum(pricing.cost_for(u, m) for m, u in self.usage_by_model.items()) if self.priced else 0.0
        return {
            "i": self.index,
            "condition": self.condition,
            "start": self.start,
            "end": self.end,
            "ms": span_ms(self.start, end),
            "open": self.open,
            "met": self.met,
            "superseded": self.superseded,
            "status": self.status(),
            "checks": list(self.checks),
            "dropped_checks": self.dropped_checks,
            "blocked_stops": len(blocked),
            "last_reason": (blocked[-1]["reason"] if blocked
                            else (self.checks[-1]["reason"] if self.checks else "")),
            "follow_ups": self.follow_ups,
            "commands": self.commands,
            "request_ids": list(self.request_ids),
            "turns": self.turns,
            "tools": self.tool_calls,
            "by_cat": dict(self.by_cat),
            "cat_ms": self.spans.result(),
            "tool_ms": self.spans.total,
            "errors": self.errors,
            "asked": self.asked,
            "subagents": self.subagents,
            "compactions": self.compactions,
            "tokens": sum(u.total for u in self.usage_by_model.values()),
            "cost": round(cost, 4),
            "files": sorted(self.files)[:10],
        }


class GoalTracker:
    """Reconstructs ``/goal`` runs from the transcript's goal_status attachments."""

    def __init__(self, *, priced: bool = True) -> None:
        self.goals: list[GoalRun] = []
        self.dropped = 0
        self.priced = priced
        self._counter = 0

    @property
    def current(self) -> GoalRun | None:
        for goal in reversed(self.goals):
            if goal.open:
                return goal
        return None

    def _append(self, goal: GoalRun) -> None:
        self.goals.append(goal)
        if len(self.goals) > MAX_GOALS:
            self.dropped += 1
            self.goals.pop(0)

    def set_goal(self, condition: str, ts: str) -> None:
        """A goal was set. Any goal still open is replaced, not forgotten."""
        condition = (condition or "").strip()[:CONDITION_PREVIEW]
        open_goal = self.current
        if open_goal is not None:
            if open_goal.condition == condition:
                return          # the same goal re-announced; not a new run
            open_goal.close(ts, met=False, superseded=True)
        self._counter += 1
        self._append(GoalRun(self._counter - 1, condition, ts or "", priced=self.priced))

    def status(self, condition: str, met: bool, reason: str, ts: str) -> None:
        """The Stop hook evaluated the condition — either blocking or releasing."""
        condition = (condition or "").strip()[:CONDITION_PREVIEW]
        goal = self.current
        if goal is None or (condition and goal.condition != condition):
            # A status for a goal we never saw set — a resumed session, or a
            # transcript window that starts mid-run. Open one so it is not lost.
            if not condition:
                return
            self._counter += 1
            goal = GoalRun(self._counter - 1, condition, ts or "", priced=self.priced)
            self._append(goal)
        goal.add_check(met, reason, ts or "")
        if met:
            goal.close(ts, met=True)

    def feed_record(self, record: dict) -> bool:
        """Consume a raw transcript record; True if it was a goal event.

        Goal events arrive as attachments rather than messages, so this runs
        before the message-shaped parsing the rest of the builder does.
        """
        if not isinstance(record, dict):
            return False
        attachment = record.get("attachment")
        if not isinstance(attachment, dict) or attachment.get("type") != "goal_status":
            return False
        ts = str(record.get("timestamp") or "")
        condition = str(attachment.get("condition") or "")
        met = bool(attachment.get("met"))
        if attachment.get("sentinel") and not met:
            self.set_goal(condition, ts)
        else:
            self.status(condition, met, str(attachment.get("reason") or ""), ts)
        return True

    def result(self, last_ts: str = "") -> dict:
        goals = [goal.to_dict(last_ts) for goal in self.goals]
        durations = [goal["ms"] for goal in goals if goal["ms"]]
        return {
            "goals": goals,
            "dropped": self.dropped,
            "count": self._counter,
            "open": sum(1 for goal in goals if goal["open"]),
            "met": sum(1 for goal in goals if goal["met"]),
            "superseded": sum(1 for goal in goals if goal["superseded"]),
            "total_ms": sum(durations),
            "median_ms": _median(durations),
            "blocked_stops": sum(goal["blocked_stops"] for goal in goals),
            "follow_ups": sum(goal["follow_ups"] for goal in goals),
        }


# --------------------------------------------------------------------------- #
# the two levels, fed as one                                                    #
# --------------------------------------------------------------------------- #


class SessionArc:
    """The single entry point the parsers feed.

    Everything is recorded once and attributed to both levels at the moment it
    happens — the open request, and the goal that was running. Nothing is
    reconstructed afterwards by matching timestamps, which is what made an
    early version charge a long-running request to the wrong goal.
    """

    def __init__(self, *, priced: bool = True) -> None:
        self.requests = RequestTracker(priced=priced)
        self.goals = GoalTracker(priced=priced)
        # call_id -> (request index, tool name, category, start ms, goal index)
        self._pending: dict[str, tuple[int, str, str, int, int]] = {}

    # -- goals -------------------------------------------------------------- #

    def feed_record(self, record: dict) -> bool:
        """Offer a raw record to the goal tracker; True if it consumed it."""
        return self.goals.feed_record(record)

    # -- requests ----------------------------------------------------------- #

    def begin(self, prompt: str, ts: str) -> None:
        kind = self.requests.begin(prompt, ts)
        goal = self.goals.current
        if goal is None or kind == "noise":
            return
        request = self.requests.current
        if request is not None:
            goal.request_ids.append(request.index)
        if kind == "command":
            goal.commands += 1
        else:
            goal.follow_ups += 1

    def tool(self, name: str, ts: str, call_id: str = "") -> None:
        category = categorize(name)
        request = self.requests.ensure(ts)
        request.add_tool(name, category, ts, call_id)
        goal = self.goals.current
        if goal is not None:
            goal.by_cat[category] = goal.by_cat.get(category, 0) + 1
            if category == "ask":
                goal.asked += 1
            if category == "agent":
                goal.subagents += 1
        if call_id:
            self._pending[call_id] = (
                request.index, str(name), category, epoch_ms(ts),
                goal.index if goal is not None else -1,
            )
            if len(self._pending) > MAX_PENDING_CALLS:
                for key in list(self._pending)[: MAX_PENDING_CALLS // 2]:
                    self._pending.pop(key, None)

    def tool_result(self, call_id: str, ts: str, *, is_error: bool = False) -> None:
        """A tool call came back. This is where a call's real duration is known."""
        pending = self._pending.pop(call_id, None) if call_id else None
        if pending is not None:
            index, name, category, started, goal_index = pending
            finished = epoch_ms(ts)
            request = self.requests.by_index(index)
            if request is not None and started and finished > started:
                request.close_call(call_id, category, started, finished)
            if started and finished > started:
                self.requests.spans.add(category, started, finished)
                for goal in self.goals.goals:
                    if goal.index == goal_index:
                        goal.spans.add(category, started, finished)
                        break
            if is_error:
                if request is not None:
                    request.mark_error(call_id, name)
                for goal in self.goals.goals:
                    if goal.index == goal_index:
                        goal.errors += 1
                        break
            return
        if is_error:
            # An error for a call we never saw — charge the open request so the
            # count still reflects reality.
            request = self.requests.current
            if request is not None:
                request.mark_error(call_id, "")
            goal = self.goals.current
            if goal is not None:
                goal.errors += 1

    def turn(self, ts: str, model: str = "", usage: pricing.Usage | None = None) -> None:
        self.requests.ensure(ts).add_turn(ts, model, usage)
        goal = self.goals.current
        if goal is not None:
            goal.turns += 1
            if usage is not None:
                goal.usage_by_model.setdefault(model or "unknown", pricing.Usage()).add(usage)

    def thinking(self, chars: int, ts: str = "") -> None:
        request = self.requests.ensure(ts)
        request.thinking_chars += chars
        request.touch(ts)

    def text(self, chars: int, ts: str = "") -> None:
        request = self.requests.ensure(ts)
        request.text_chars += chars
        request.touch(ts)

    def file(self, path: str) -> None:
        request = self.requests.current
        if request is not None and path:
            request.files[str(path)] = request.files.get(str(path), 0) + 1
        goal = self.goals.current
        if goal is not None and path:
            goal.files.add(str(path))

    def command(self, command: str) -> None:
        request = self.requests.current
        if request is not None and command:
            request.commands[str(command)] = request.commands.get(str(command), 0) + 1

    def compaction(self) -> None:
        request = self.requests.current
        if request is not None:
            request.compactions += 1
        goal = self.goals.current
        if goal is not None:
            goal.compactions += 1

    def touch(self, ts: str) -> None:
        self.requests.touch(ts)

    # -- output ------------------------------------------------------------- #

    def result(self, last_ts: str = "") -> dict:
        return {
            "requests": self.requests.result(),
            "goals": self.goals.result(last_ts),
        }
