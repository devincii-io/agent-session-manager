"""Goal segmentation: turning a flat transcript into the arc of the work.

A session transcript is a list of messages. What a person actually remembers
about a session is coarser: *"I asked for X, it read some files, ran the tests
twice, hit an error, asked me a question, and finished."* That shape — one user
prompt, everything the agent did until the next prompt, and how it ended — is
what this module reconstructs.

One **goal** spans from a real user prompt to the moment the next one arrives.
Tool results are not prompts, so a goal survives the whole tool loop. Each goal
records when it started and ended, which *kinds* of tools ran inside it (reads
are not edits, and neither is a shell command), whether the agent stopped to ask
something, and what it cost.

The tracker is fed incrementally, exactly like the summary and detail builders
around it, so a live session appends to the open goal instead of re-deriving
every goal on each refresh.
"""

from __future__ import annotations

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

MAX_GOALS = 400          # a session with more prompts than this keeps the newest
MAX_STEPS = 240          # per goal; enough to draw a dense lane, bounded payload
PROMPT_PREVIEW = 260


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
# echoes, captured stdout, injected reminders. They must not open a goal, or a
# session's arc becomes a list of plumbing with the real requests buried in it.
_NOISE_PREFIXES = (
    # Claude Code
    "<local-command-caveat", "<local-command-stdout", "<local-command-stderr",
    "<command-message", "<command-args", "<system-reminder",
    "<bash-input", "<bash-stdout", "<bash-stderr", "caveat:",
    "[request interrupted", "<user-prompt-submit-hook",
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


def _clean_prompt(text: str) -> str:
    """A prompt as a person would recognise it: one line, no XML scaffolding."""
    return classify_prompt(text)[1]


class Goal:
    """One user prompt and everything that happened until the next one."""

    __slots__ = (
        "index", "prompt", "start", "end", "turns", "steps", "by_cat",
        "errors", "error_names", "subagents", "asked", "files", "commands",
        "usage_by_model", "output_tokens", "thinking_chars", "text_chars",
        "models", "first_response", "dropped_steps", "compactions", "priced",
        "kind",
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
        # Codex records tokens but proves nothing about billing, so its goals
        # carry token counts and no dollar figure at all.
        self.priced = True
        self.kind = "prompt"

    # -- accumulation ------------------------------------------------------- #

    def touch(self, ts: str) -> None:
        if ts and ts > self.end:
            self.end = ts

    def add_tool(self, name: str, ts: str, call_id: str = "") -> None:
        category = categorize(name)
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
        """How the goal ended, in the terms a person would use."""
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
            "ms": _span_ms(self.start, self.end),
            "latency_ms": _span_ms(self.start, self.first_response),
            "turns": self.turns,
            "tools": self.tool_calls,
            "by_cat": dict(self.by_cat),
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


def _span_ms(start: str, end: str) -> int:
    """Milliseconds between two ISO-8601 stamps; 0 when either is unusable."""
    if not start or not end:
        return 0
    from datetime import datetime

    try:
        a = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
        b = datetime.fromisoformat(str(end).replace("Z", "+00:00"))
    except ValueError:
        return 0
    delta = (b - a).total_seconds() * 1000.0
    return int(delta) if delta > 0 else 0


class GoalTracker:
    """Incremental goal segmentation shared by the Claude and Codex parsers."""

    def __init__(self, *, priced: bool = True) -> None:
        self.goals: list[Goal] = []
        self.priced = priced
        self.dropped = 0
        self._counter = 0
        self._pending_calls: dict[str, tuple[int, str]] = {}  # call_id -> (goal idx, name)

    # -- feeding ------------------------------------------------------------ #

    def begin(self, prompt: str, ts: str) -> None:
        """Start a new goal — for every *real* user prompt, and nothing else."""
        kind, cleaned = classify_prompt(prompt)
        if kind == "noise":
            # Scaffolding, not a request. Whatever follows still belongs to the
            # goal that is already open.
            self.touch(ts)
            return
        goal = Goal(self._counter, cleaned, ts or "")
        goal.kind = kind
        goal.priced = self.priced
        self._counter += 1
        self.goals.append(goal)
        if len(self.goals) > MAX_GOALS:
            # Keep the newest window; the frontend is told how many were dropped
            # so it never presents a truncated arc as the whole session.
            self.dropped += 1
            self.goals.pop(0)

    @property
    def current(self) -> Goal | None:
        return self.goals[-1] if self.goals else None

    def _ensure(self, ts: str) -> Goal:
        """A goal to attribute work to even when a session starts mid-stream.

        A resumed session, or one whose first user record is CLI scaffolding,
        does work before any prompt this tracker recognises. That work is real
        and is kept — under a goal marked ``implicit`` so the UI can say what
        it is instead of showing an empty prompt.
        """
        goal = self.current
        if goal is None:
            goal = Goal(self._counter, "", ts or "")
            goal.priced = self.priced
            goal.kind = "implicit"
            self._counter += 1
            self.goals.append(goal)
        return goal

    def tool(self, name: str, ts: str, call_id: str = "") -> None:
        goal = self._ensure(ts)
        goal.add_tool(name, ts, call_id)
        if call_id:
            self._pending_calls[call_id] = (goal.index, str(name))
            if len(self._pending_calls) > 4000:      # bounded; oldest first
                for key in list(self._pending_calls)[:2000]:
                    self._pending_calls.pop(key, None)

    def tool_error(self, call_id: str, name: str = "") -> None:
        """A tool result that came back as an error.

        The result can land in a later goal than the call did (the user typed
        while a tool ran), so the error is charged to the goal that *made* the
        call whenever the call id is known.
        """
        owner = self.current
        known = self._pending_calls.get(call_id) if call_id else None
        if known is not None:
            index, tool_name = known
            for goal in reversed(self.goals):
                if goal.index == index:
                    goal.mark_error(call_id, tool_name)
                    return
            name = name or tool_name
        if owner is not None:
            owner.mark_error(call_id, name)

    def turn(self, ts: str, model: str = "", usage: pricing.Usage | None = None) -> None:
        self._ensure(ts).add_turn(ts, model, usage)

    def thinking(self, chars: int, ts: str = "") -> None:
        goal = self._ensure(ts)
        goal.thinking_chars += chars
        goal.touch(ts)

    def text(self, chars: int, ts: str = "") -> None:
        goal = self._ensure(ts)
        goal.text_chars += chars
        goal.touch(ts)

    def file(self, path: str) -> None:
        goal = self.current
        if goal is not None and path:
            goal.files[str(path)] = goal.files.get(str(path), 0) + 1

    def command(self, command: str) -> None:
        goal = self.current
        if goal is not None and command:
            goal.commands[str(command)] = goal.commands.get(str(command), 0) + 1

    def compaction(self) -> None:
        goal = self.current
        if goal is not None:
            goal.compactions += 1

    def touch(self, ts: str) -> None:
        goal = self.current
        if goal is not None:
            goal.touch(ts)

    # -- output ------------------------------------------------------------- #

    def result(self) -> dict:
        goals = [goal.to_dict() for goal in self.goals]
        active = [g for g in goals if g["tools"] or g["turns"]]
        total_ms = sum(g["ms"] for g in active)
        by_cat: dict[str, int] = {}
        for goal in goals:
            for category, count in goal["by_cat"].items():
                by_cat[category] = by_cat.get(category, 0) + count
        return {
            "goals": goals,
            "dropped": self.dropped,
            "count": self._counter,
            "by_cat": by_cat,
            "total_ms": total_ms,
            "median_ms": _median([g["ms"] for g in active]),
            "priced": self.priced,
            "questions": sum(1 for g in goals if g["asked"]),
            "failed": sum(1 for g in goals if g["outcome"] == "error"),
            "categories": list(CATEGORIES),
        }


def _median(values: list[int]) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) // 2
