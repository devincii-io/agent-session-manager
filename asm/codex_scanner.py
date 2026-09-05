"""Scanner for Codex's date-partitioned rollout archive.

This backend is intentionally isolated from :mod:`asm.scanner`: callers can
adopt it provider-by-provider without changing the stable Claude implementation.
Public records use the same field names as the current frontend and always carry
``provider="codex"``.

Performance mirrors the Claude scanner: summaries persist in a disk cache keyed
by mtime+size, a rollout that changes while the app runs is parsed
incrementally from its byte offset, and one walk of the archive serves every
aggregate call for a short window.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from collections import Counter
from pathlib import Path
from typing import Callable

from . import paths
from .codex_session_parser import DetailBuilder, SessionSummary, SummaryBuilder
from .session_parser import _loads, iter_file_records, read_new_lines

try:
    import orjson as _orjson
except ImportError:  # pragma: no cover
    _orjson = None

ACTIVE_WINDOW_SECONDS = 120
PROTECTED_WINDOW_SECONDS = 600
MAX_DETAIL_STATES = 2
CACHE_VERSION = 1
INDEX_TTL_SECONDS = 2.0
CACHE_SAVE_INTERVAL = 2.0

ProgressFn = Callable[[dict], None]


def _project_id(cwd: str) -> str:
    """Return a compact deterministic id without exposing a path as an API id."""
    normalized = os.path.normcase(os.path.normpath(cwd or "<unknown>"))
    digest = hashlib.sha256(normalized.encode("utf-8", "surrogatepass")).hexdigest()[:16]
    return f"codex-{digest}"


def _add_usage(target: dict, source: dict) -> None:
    for key in ("input", "output", "cache_read", "cache_write", "reasoning_output", "total"):
        target[key] = int(target.get(key, 0)) + int(source.get(key, 0) or 0)


def _usage_zero() -> dict:
    return {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "reasoning_output": 0, "total": 0}


def _dumps(obj) -> bytes:
    if _orjson is not None:
        return _orjson.dumps(obj)
    return json.dumps(obj).encode("utf-8")


class CodexScanner:
    """Incrementally index root Codex sessions and reconstruct their details."""

    def __init__(
        self,
        home: Path | None = None,
        *,
        cache_namespace: str = "local",
        on_progress: ProgressFn | None = None,
        index_ttl: float = 0.0,
    ) -> None:
        self.home = Path(home) if home is not None else paths.codex_home()
        self.sessions_root = self.home / "sessions"
        self.index_file = self.home / "session_index.jsonl"
        safe_namespace = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in cache_namespace)
        cache_name = "codex-summaries.json" if cache_namespace == "local" else f"codex-summaries-{safe_namespace}.json"
        self._cache_path = paths.cache_dir() / cache_name
        self._cache: dict[str, dict] = {}
        self._cache_dirty = False
        self._cache_saved_at = 0.0
        self.on_progress = on_progress
        self.label = cache_namespace
        self.index_ttl = float(index_ttl)   # see Scanner.index_ttl
        self._sum_states: dict[str, dict] = {}
        self._detail_states: dict[str, dict] = {}
        self._locators: dict[tuple[str, str], Path] = {}
        self._session_locators: dict[str, Path] = {}
        self._projects: dict[str, str] = {}
        self._root_summaries: dict[str, SessionSummary] = {}
        self._child_summaries: dict[str, list[SessionSummary]] = {}
        self._titles: dict[str, str] = {}
        self._title_stamp: tuple[int, int] | None = None
        self._archived: dict[str, float] = {}
        self._archive_state_known = False
        self._archive_stamp: tuple[str, int, int] | None = None
        self._discovered_at = 0.0
        self._load_cache()

    # -- summary cache ------------------------------------------------------ #

    def _load_cache(self) -> None:
        try:
            blob = _loads(self._cache_path.read_bytes())
            self._cache = blob.get("entries", {}) if blob.get("_v") == CACHE_VERSION else {}
        except (OSError, ValueError, AttributeError):
            self._cache = {}

    def _save_cache(self, *, force: bool = False) -> None:
        if not self._cache_dirty:
            return
        if not force and time.time() - self._cache_saved_at < CACHE_SAVE_INTERVAL:
            return
        try:
            self._cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._cache_path.with_suffix(".tmp")
            tmp.write_bytes(_dumps({"_v": CACHE_VERSION, "entries": self._cache}))
            os.replace(tmp, self._cache_path)
            self._cache_dirty = False
            self._cache_saved_at = time.time()
        except OSError:
            pass

    def flush(self) -> None:
        self._save_cache(force=True)

    def invalidate(self) -> None:
        self._discovered_at = 0.0

    # -- incremental parsing -------------------------------------------------

    @staticmethod
    def _feed_lines(builder, path: Path, offset: int) -> int:
        lines, new_offset = read_new_lines(path, offset)
        for line in lines:
            if not line:
                continue
            try:
                record = _loads(line)
            except (TypeError, ValueError):
                continue
            try:
                builder.feed(record)
            except Exception:
                # A future record variant must not hide the rest of the archive.
                continue
        return new_offset

    def _cached_summary(self, rollout: Path, stat: os.stat_result) -> SessionSummary | None:
        cached = self._cache.get(str(rollout))
        if cached and cached.get("size_bytes") == stat.st_size and cached.get("mtime") == stat.st_mtime:
            try:
                return SessionSummary(**cached)
            except TypeError:
                return None
        return None

    def _parse_summary(self, rollout: Path, stat: os.stat_result) -> SessionSummary | None:
        key = str(rollout)
        state = self._sum_states.get(key)
        if state is None or state["offset"] > stat.st_size:
            state = {"builder": SummaryBuilder(), "offset": 0}
            self._sum_states[key] = state
        state["offset"] = self._feed_lines(state["builder"], rollout, state["offset"])
        builder: SummaryBuilder = state["builder"]
        # Until the first complete session_meta line is available there is no
        # safe identity.  In particular, the rollout filename is not the API id.
        if not builder.session_id:
            return None
        summary = builder.result(builder.session_id, key, stat.st_size, stat.st_mtime)
        self._cache[key] = summary.to_dict()
        self._cache_dirty = True
        return summary

    def _summary(self, rollout: Path) -> SessionSummary | None:
        try:
            stat = rollout.stat()
        except OSError:
            return None
        cached = self._cached_summary(rollout, stat)
        if cached is not None:
            return cached
        return self._parse_summary(rollout, stat)

    def _load_titles(self) -> None:
        try:
            stat = self.index_file.stat()
            stamp = (stat.st_size, stat.st_mtime_ns)
        except OSError:
            self._titles = {}
            self._title_stamp = None
            return
        if stamp == self._title_stamp:
            return
        titles: dict[str, str] = {}
        for record in iter_file_records(self.index_file):
            if not isinstance(record, dict):
                continue
            sid = str(record.get("id") or "")
            title = str(record.get("thread_name") or record.get("title") or "").strip()
            if sid and title:
                titles[sid] = title
        self._titles = titles
        self._title_stamp = stamp

    def _discover(self, *, fresh: bool = False) -> None:
        if not fresh and time.time() - self._discovered_at < self.index_ttl:
            return
        self._load_titles()
        self._load_archived_state()
        summaries: list[SessionSummary] = []
        pending: list[tuple[Path, os.stat_result]] = []
        if self.sessions_root.is_dir():
            for rollout in self.sessions_root.rglob("*.jsonl"):
                try:
                    stat = rollout.stat()
                except OSError:
                    continue
                cached = self._cached_summary(rollout, stat)
                if cached is not None:
                    summaries.append(cached)
                else:
                    pending.append((rollout, stat))
        total = len(pending)
        report = self.on_progress if total >= 3 else None
        for index, (rollout, stat) in enumerate(pending):
            if report:
                report({"kind": "index", "source": self.label, "provider": "codex",
                        "done": index, "total": total, "file": rollout.name})
            summary = self._parse_summary(rollout, stat)
            if summary is not None:
                summaries.append(summary)
        if report:
            report({"kind": "index", "source": self.label, "provider": "codex",
                    "done": total, "total": total, "file": ""})

        # Prefer the newest duplicate if an imported archive repeats an id.
        by_id: dict[str, SessionSummary] = {}
        for summary in summaries:
            previous = by_id.get(summary.session_id)
            if previous is None or summary.mtime >= previous.mtime:
                by_id[summary.session_id] = summary

        roots: dict[str, SessionSummary] = {}
        children: dict[str, list[SessionSummary]] = {}
        projects: dict[str, str] = {}
        locators: dict[tuple[str, str], Path] = {}
        session_locators: dict[str, Path] = {}

        for summary in by_id.values():
            session_locators[summary.session_id] = Path(summary.path)
            if summary.is_subagent:
                if summary.parent_session_id:
                    children.setdefault(summary.parent_session_id, []).append(summary)
                continue
            pid = _project_id(summary.cwd)
            projects[pid] = summary.cwd
            summary.title = self._titles.get(summary.session_id, summary.title)
            roots[summary.session_id] = summary
            locators[(pid, summary.session_id)] = Path(summary.path)

        for parent_id, child_items in children.items():
            parent = roots.get(parent_id)
            if parent is not None:
                parent.has_subagents = True
                parent.subagent_calls = max(parent.subagent_calls, len(child_items))

        self._projects = projects
        self._locators = locators
        self._session_locators = session_locators
        self._root_summaries = roots
        self._child_summaries = children
        self._discovered_at = time.time()
        self._save_cache()

    def _load_archived_state(self) -> None:
        """Read Codex's versioned state database without ever mutating it."""
        candidates = sorted(self.home.glob("state_*.sqlite"), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
        if not candidates:
            self._archived = {}
            self._archive_state_known = False
            self._archive_stamp = None
            return
        try:
            stat = candidates[0].stat()
            stamp = (str(candidates[0]), stat.st_size, stat.st_mtime_ns)
        except OSError:
            stamp = None
        if stamp is not None and stamp == self._archive_stamp:
            return
        self._archived = {}
        self._archive_state_known = False
        db = None
        try:
            uri = candidates[0].resolve().as_uri() + "?mode=ro"
            db = sqlite3.connect(uri, uri=True, timeout=1)
            columns = {row[1] for row in db.execute("PRAGMA table_info(threads)")}
            if not {"id", "archived"}.issubset(columns):
                return
            archived_at = "archived_at" if "archived_at" in columns else "NULL"
            rows = db.execute(f"SELECT id, {archived_at} FROM threads WHERE archived = 1").fetchall()
            self._archived = {str(sid): float(archived_at or 0) for sid, archived_at in rows}
            self._archive_state_known = True
            self._archive_stamp = stamp
        except (OSError, sqlite3.Error, ValueError):
            return
        finally:
            if db is not None:
                db.close()

    def _visible_roots(self):
        return (summary for sid, summary in self._root_summaries.items() if sid not in self._archived)

    # -- projects and summaries ---------------------------------------------

    def scan_projects(self) -> list[dict]:
        self._discover()
        now = time.time()
        grouped: dict[str, list[SessionSummary]] = {}
        for summary in self._visible_roots():
            grouped.setdefault(_project_id(summary.cwd), []).append(summary)
        result: list[dict] = []
        for pid, summaries in grouped.items():
            cwd = self._projects.get(pid, "")
            last_activity = max((item.mtime for item in summaries), default=0.0)
            result.append({
                "provider": "codex",
                "id": pid,
                "path": cwd,
                "name": Path(cwd).name if cwd else "Unknown project",
                "session_count": len(summaries),
                "active_count": sum(1 for item in summaries if now - item.mtime <= ACTIVE_WINDOW_SECONDS),
                "total_cost": 0.0,
                "cost_available": False,
                "total_tokens": sum(int(item.usage.get("total", 0)) for item in summaries),
                "active_ms": sum(item.active_ms for item in summaries),
                "tool_errors": sum(item.tool_errors for item in summaries),
                "last_activity": last_activity,
                "memory_count": 0,
                "exists": bool(cwd) and Path(cwd).is_dir(),
            })
        result.sort(key=lambda item: item["last_activity"], reverse=True)
        return result

    def list_sessions(self, project_id: str) -> list[dict]:
        self._discover()
        now = time.time()
        result: list[dict] = []
        for summary in self._visible_roots():
            if _project_id(summary.cwd) != project_id:
                continue
            item = summary.to_dict()
            item["provider"] = "codex"
            item["active"] = now - summary.mtime <= ACTIVE_WINDOW_SECONDS
            item["protected"] = now - summary.mtime <= PROTECTED_WINDOW_SECONDS
            item["child_session_count"] = len(self._child_summaries.get(summary.session_id, []))
            result.append(item)
        result.sort(key=lambda item: item["mtime"], reverse=True)
        return result

    def summaries_for(self, items: list) -> list[dict]:
        self._discover()
        result = []
        for item in items or []:
            if not isinstance(item, dict) or item.get("provider", "codex") != "codex":
                continue
            summary = self._root_summaries.get(str(item.get("session_id") or ""))
            if summary is not None:
                result.append(summary.to_dict())
        return result

    def project_path(self, project_id: str) -> str:
        self._discover()
        return self._projects.get(project_id, "")

    # -- locator-backed detail API ------------------------------------------

    def session_path(self, project_id: str, session_id: str | None = None) -> Path | None:
        """Resolve a canonical id; accepts ``(session_id)`` or ``(pid, sid)``."""
        self._discover()
        if session_id is None:
            return self._session_locators.get(project_id)
        return self._locators.get((project_id, session_id))

    def _detail_builder(self, rollout: Path) -> DetailBuilder | None:
        key = str(rollout)
        try:
            size = rollout.stat().st_size
        except OSError:
            return None
        state = self._detail_states.get(key)
        if state is None or state["offset"] > size:
            state = {"builder": DetailBuilder(), "offset": 0, "used": 0.0}
            self._detail_states[key] = state
            if len(self._detail_states) > MAX_DETAIL_STATES:
                candidates = [item for item in self._detail_states if item != key]
                if candidates:
                    oldest = min(candidates, key=lambda item: self._detail_states[item]["used"])
                    del self._detail_states[oldest]
        state["offset"] = self._feed_lines(state["builder"], rollout, state["offset"])
        state["used"] = time.time()
        return state["builder"]

    def detail(self, project_id: str, session_id: str | None = None, *, tail: int = 60) -> dict:
        """Return details; accepts ``detail(session_id)`` or ``detail(pid, sid)``."""
        rollout = self.session_path(project_id, session_id)
        if rollout is None:
            return {"provider": "codex", "events": [], "error": "not found"}
        builder = self._detail_builder(rollout)
        if builder is None:
            return {"provider": "codex", "events": [], "error": "not found"}
        result = builder.meta()
        result["events"], result["events_start"] = builder.tail(tail)
        sid = session_id if session_id is not None else project_id
        result["session_id"] = sid
        if session_id is not None:
            result["project_id"] = project_id
        child_items = self._child_summaries.get(sid, [])
        result["child_sessions"] = [
            {
                "provider": "codex",
                "session_id": child.session_id,
                "parent_session_id": child.parent_session_id,
                "agent_path": child.agent_path,
                "title": child.first_prompt or child.agent_path or "Subagent",
                "mtime": child.mtime,
                "models": child.models,
            }
            for child in sorted(child_items, key=lambda item: item.mtime)
        ]
        if child_items:
            result["subagents"]["count"] = max(result["subagents"].get("count", 0), len(child_items))
        return result

    def detail_meta(self, project_id: str, session_id: str) -> dict:
        """Aggregates only, for a live refresh of an already-open session."""
        rollout = self.session_path(project_id, session_id)
        builder = self._detail_builder(rollout) if rollout is not None else None
        if builder is None:
            return {"provider": "codex", "error": "not found"}
        result = builder.meta()
        result["session_id"] = session_id
        result["project_id"] = project_id
        return result

    def transcript_before(self, project_id: str, session_id: str, before: int, count: int) -> dict:
        rollout = self.session_path(project_id, session_id)
        builder = self._detail_builder(rollout) if rollout is not None else None
        if builder is None:
            return {"provider": "codex", "events": [], "start": 0, "total": 0}
        events, start = builder.page_before(before, count)
        return {"provider": "codex", "events": events, "start": start, "total": len(builder.events)}

    def transcript_after(self, project_id: str, session_id: str, after: int) -> dict:
        rollout = self.session_path(project_id, session_id)
        builder = self._detail_builder(rollout) if rollout is not None else None
        if builder is None:
            return {"provider": "codex", "events": [], "start": 0, "total": 0}
        events, start = builder.page_after(after)
        return {"provider": "codex", "events": events, "start": start, "total": len(builder.events)}

    def release_detail(self, project_id: str, session_id: str | None = None) -> None:
        rollout = self.session_path(project_id, session_id)
        if rollout is not None:
            self._detail_states.pop(str(rollout), None)

    # -- aggregate/search views ---------------------------------------------

    def all_sessions(self) -> dict:
        self._discover()
        now = time.time()
        records: list[dict] = []
        for summary in self._root_summaries.values():
            records.append({
                "provider": "codex",
                "project_id": _project_id(summary.cwd),
                "project_name": Path(summary.cwd).name if summary.cwd else "Unknown project",
                "project_path": summary.cwd,
                "session_id": summary.session_id,
                "title": summary.title or summary.first_prompt or "Untitled session",
                "first_prompt": summary.first_prompt,
                "cost": 0.0,
                "cost_available": False,
                "tokens": int(summary.usage.get("total", 0)),
                "user_messages": summary.user_messages,
                "assistant_messages": summary.assistant_messages,
                "tool_calls": summary.tool_calls,
                "tool_errors": summary.tool_errors,
                "compactions": summary.compactions,
                "active_ms": summary.active_ms,
                "size_bytes": summary.size_bytes,
                "extra_bytes": 0,
                "mtime": summary.mtime,
                "created": summary.created,
                "active": now - summary.mtime <= ACTIVE_WINDOW_SECONDS,
                "protected": now - summary.mtime <= PROTECTED_WINDOW_SECONDS,
                "has_subagents": summary.has_subagents,
                "context_pct": summary.context_pct,
                "child_session_count": len(self._child_summaries.get(summary.session_id, [])),
                "models": list(summary.models),
                "archived": summary.session_id in self._archived,
                "archived_at": self._archived.get(summary.session_id, 0),
                "archive_state_known": self._archive_state_known,
            })
        records.sort(key=lambda item: item["size_bytes"], reverse=True)
        return {
            "provider": "codex",
            "sessions": records,
            "home": str(self.home),
            "total_bytes": sum(item["size_bytes"] for item in records),
            "cost_available": False,
        }

    def global_stats(self) -> dict:
        self._discover()
        usage = _usage_zero()
        by_model: dict[str, dict] = {}
        tools: Counter[str] = Counter()
        days: Counter[str] = Counter()
        daily: dict[str, dict] = {}
        heat = [[0] * 24 for _ in range(7)]
        now = time.time()
        active = prompts = turns = tool_calls = subagent_sessions = 0
        active_ms = tool_errors = compactions = kills = interrupts = 0
        first_activity = ""
        by_project: dict[str, dict] = {}
        agents: dict[str, dict] = {}
        skills: dict[str, dict] = {}
        commands: dict[str, dict] = {}

        def roll(table: dict, counts: dict, project_name: str, when: float) -> None:
            for name, n in (counts or {}).items():
                row = table.setdefault(name, {"count": 0, "sessions": 0, "projects": set(), "last": 0.0})
                row["count"] += int(n or 0)
                row["sessions"] += 1
                row["projects"].add(project_name)
                row["last"] = max(row["last"], when)

        for summary in self._visible_roots():
            _add_usage(usage, summary.usage)
            prompts += summary.user_messages
            turns += summary.assistant_messages
            tool_calls += summary.tool_calls
            active_ms += summary.active_ms
            tool_errors += summary.tool_errors
            compactions += summary.compactions
            kills += summary.kills
            interrupts += summary.interrupts
            if summary.has_subagents:
                subagent_sessions += 1
            if now - summary.mtime <= ACTIVE_WINDOW_SECONDS:
                active += 1
            if summary.created and (not first_activity or summary.created < first_activity):
                first_activity = summary.created
            for model, model_usage in summary.usage_by_model.items():
                bucket = by_model.setdefault(model, _usage_zero())
                _add_usage(bucket, model_usage)
            tools.update(summary.tool_counts)
            for slot, count in (summary.activity or {}).items():
                try:
                    wday, hour = slot.split(":")
                    heat[int(wday)][int(hour)] += int(count)
                except (ValueError, IndexError):
                    continue
            for day, row in (summary.daily or {}).items():
                bucket = daily.setdefault(day, {"d": day, "cost": 0.0, "tokens": 0, "turns": 0, "prompts": 0,
                                                "errors": 0, "active_ms": 0, "sessions": 0, "models": {}})
                bucket["tokens"] += int(row.get("t", 0) or 0)
                bucket["turns"] += int(row.get("n", 0) or 0)
                bucket["prompts"] += int(row.get("p", 0) or 0)
                bucket["errors"] += int(row.get("e", 0) or 0)
                bucket["active_ms"] += int(row.get("a", 0) or 0)
                bucket["sessions"] += 1
            if summary.mtime:
                days[time.strftime("%Y-%m-%d", time.localtime(summary.mtime))] += 1
            name = Path(summary.cwd).name if summary.cwd else "Unknown project"
            pid = _project_id(summary.cwd)
            project = by_project.setdefault(pid, {
                "id": pid, "name": name, "path": summary.cwd, "sessions": 0, "cost": 0.0, "tokens": 0,
                "turns": 0, "active_ms": 0, "errors": 0, "last_activity": 0.0, "compactions": 0,
                "skills": 0, "agents": 0, "kills": 0, "interrupts": 0,
            })
            project["sessions"] += 1
            project["tokens"] += int(summary.usage.get("total", 0))
            project["turns"] += summary.assistant_messages
            project["active_ms"] += summary.active_ms
            project["errors"] += summary.tool_errors
            project["compactions"] += summary.compactions
            project["agents"] += sum((summary.agents or {}).values())
            project["kills"] += summary.kills
            project["interrupts"] += summary.interrupts
            project["last_activity"] = max(project["last_activity"], summary.mtime)
            roll(agents, summary.agents, pid, summary.mtime)
            roll(skills, summary.skills, pid, summary.mtime)
            roll(commands, summary.commands, pid, summary.mtime)

        by_day = []
        daily_rows = []
        for offset in range(89, -1, -1):
            day = time.strftime("%Y-%m-%d", time.localtime(now - offset * 86400))
            by_day.append([day, days.get(day, 0)])
            daily_rows.append(daily.get(day) or {"d": day, "cost": 0.0, "tokens": 0, "turns": 0, "prompts": 0,
                                                 "errors": 0, "active_ms": 0, "sessions": 0, "models": {}})

        def rolled(table: dict) -> dict:
            return {name: {**row, "projects": len(row["projects"])} for name, row in table.items()}

        return {
            "provider": "codex",
            "cost": 0.0,
            "cost_available": False,
            "usage": usage,
            "sessions": sum(1 for _ in self._visible_roots()),
            "active": active,
            "prompts": prompts,
            "turns": turns,
            "tool_calls": tool_calls,
            "tool_errors": tool_errors,
            "compactions": compactions,
            "active_ms": active_ms,
            "subagent_sessions": subagent_sessions,
            "first_activity": first_activity,
            "skills": rolled(skills),
            "agents": rolled(agents),
            "commands": rolled(commands),
            "kills": kills,
            "interrupts": interrupts,
            "by_model": {model: {**item, "cost": 0.0, "cost_available": False} for model, item in by_model.items()},
            "tool_counts": dict(tools.most_common(24)),
            "sessions_by_day": by_day,
            "daily": daily_rows,
            "activity": heat,
            "by_project": sorted(by_project.values(), key=lambda p: p["last_activity"], reverse=True),
        }

    def trace_events(self, limit: int = 500) -> list[dict]:
        self._discover()
        out: list[dict] = []
        for summary in self._visible_roots():
            name = Path(summary.cwd).name if summary.cwd else "Unknown project"
            for row in summary.trace or []:
                out.append({
                    **row,
                    "session_id": summary.session_id,
                    "project_id": _project_id(summary.cwd),
                    "project_name": name,
                    "title": summary.title or summary.first_prompt or "Untitled session",
                })
        out.sort(key=lambda row: row.get("t", 0), reverse=True)
        return out[:limit]

    def search_all(self, query: str) -> dict:
        self._discover()
        needle = query.lower().strip()
        if not needle:
            return {"provider": "codex", "sessions": [], "prompts": []}
        sessions: list[dict] = []
        prompts: list[dict] = []
        for summary in self._visible_roots():
            haystack = " ".join((summary.title, summary.first_prompt, summary.cwd, summary.session_id)).lower()
            if needle in haystack:
                sessions.append({
                    "provider": "codex",
                    "project_id": _project_id(summary.cwd),
                    "project_name": Path(summary.cwd).name if summary.cwd else "Unknown project",
                    "session_id": summary.session_id,
                    "title": summary.title or summary.first_prompt,
                    "cost": 0.0,
                    "cost_available": False,
                    "mtime": summary.mtime,
                })
            if needle in summary.first_prompt.lower():
                prompts.append({
                    "provider": "codex",
                    "display": summary.first_prompt[:220],
                    "project": summary.cwd,
                    "project_name": Path(summary.cwd).name if summary.cwd else "",
                    "project_id": _project_id(summary.cwd),
                    "session_id": summary.session_id,
                    "timestamp": summary.created or summary.mtime,
                })
        sessions.sort(key=lambda item: item["mtime"], reverse=True)
        return {"provider": "codex", "sessions": sessions[:50], "prompts": prompts[:50]}
