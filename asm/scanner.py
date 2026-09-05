"""Enumerate Claude Code's on-disk state: projects, sessions, memory, tasks,
scratchpads, images, shells, settings and the optional live statusline capture.

Performance:

* Session summaries persist in a disk cache keyed by mtime+size, written with
  ``orjson`` and saved at most every couple of seconds rather than after every
  scan.
* For files that change while the app runs, an in-memory *incremental* builder
  (byte offset + aggregates) parses only appended bytes — live sessions cost
  microseconds per refresh instead of a full re-parse.
* One walk of ``projects/`` serves every aggregate view for a short window, so
  the overview, the recent list and the global stats fired together by the
  frontend share a single pass instead of stat-ing every file three times.
* The opened session's transcript uses the same incremental scheme.

Nothing here touches Qt. The bridge runs these methods on worker threads and
guards each scanner with a lock, so a method may assume it is the only one
running against ``self`` at a time but must never block on the GUI.
"""

from __future__ import annotations

import json
import os
import time
from collections import Counter
from dataclasses import asdict
from pathlib import Path
from typing import Callable

from . import paths, pricing
from .session_parser import (
    DetailBuilder,
    SessionSummary,
    SummaryBuilder,
    _loads,
    iter_jsonl_files,
    read_new_lines,
    ts_ms,
)

try:
    import orjson as _orjson
except ImportError:  # pragma: no cover
    _orjson = None

DAY_HISTORY = 90          # calendar days of activity kept in global stats
ACTIVE_WINDOW_SECONDS = 120  # a session whose jsonl changed this recently is "live"
PROTECTED_WINDOW_SECONDS = 600  # conservative deletion guard for quiet tool/model runs
CACHE_VERSION = 3  # bump when SessionSummary's schema or computation changes
MAX_DETAIL_STATES = 2  # incremental transcript states kept in memory
INDEX_TTL_SECONDS = 2.0   # how long one projects/ walk serves repeated aggregate calls
ASSET_TTL_SECONDS = 60.0  # ancillary-directory sizes change slowly and cost a walk each
CACHE_SAVE_INTERVAL = 2.0  # seconds between cache writes while sessions are live

ProgressFn = Callable[[dict], None]


def _dumps(obj) -> bytes:
    if _orjson is not None:
        return _orjson.dumps(obj)
    return json.dumps(obj).encode("utf-8")


class Scanner:
    def __init__(
        self,
        home: Path | None = None,
        *,
        cache_namespace: str = "local",
        temp_roots: list[Path] | None = None,
        on_progress: ProgressFn | None = None,
        index_ttl: float = 0.0,
    ) -> None:
        self.home = Path(home) if home is not None else paths.claude_home()
        self.projects_root = self.home / "projects"
        self._temp_roots = list(temp_roots) if temp_roots is not None else paths.temp_roots()
        safe_namespace = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in cache_namespace)
        cache_name = "summaries.json" if cache_namespace == "local" else f"summaries-{safe_namespace}.json"
        self._cache_path = paths.cache_dir() / cache_name
        self._cache: dict[str, dict] = {}
        self._cache_dirty = False
        self._cache_saved_at = 0.0
        # path -> {"builder": SummaryBuilder, "offset": int}
        self._sum_states: dict[str, dict] = {}
        # path -> {"builder": DetailBuilder, "offset": int, "used": float}
        self._detail_states: dict[str, dict] = {}
        self._history_records: list[dict] = []
        self._history_offset = 0
        self._index_memo: tuple[float, list] | None = None
        self._asset_memo: tuple[float, dict] | None = None
        # Bumped by invalidate(); a walk that started before the bump is not
        # memoised, so a change during a long cold index is never served stale.
        self._generation = 0
        self.on_progress = on_progress
        self.label = cache_namespace
        # How long one walk of projects/ may serve repeated aggregate calls.
        # Off by default so a caller without a filesystem watcher always sees
        # the disk as it is; the bridge turns it on and invalidates on events.
        self.index_ttl = float(index_ttl)
        self._load_cache()

    # -- summary cache ------------------------------------------------------ #

    def _load_cache(self) -> None:
        try:
            blob = _loads(self._cache_path.read_bytes())
            self._cache = blob.get("entries", {}) if blob.get("_v") == CACHE_VERSION else {}
        except (OSError, ValueError, AttributeError):
            self._cache = {}

    def _save_cache(self, *, force: bool = False) -> None:
        """Persist the cache, but not on every scan while a session is live."""
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
        """Write anything still pending — called when the app closes."""
        self._save_cache(force=True)

    def invalidate(self) -> None:
        """The filesystem changed: the next aggregate call walks again.

        Called from the GUI thread without the scanner lock (plain attribute
        writes are safe under the GIL), so a watcher event never waits behind
        a worker that is in the middle of a long parse.
        """
        self._generation += 1
        self._index_memo = None
        self._asset_memo = None

    def _feed_lines(self, builder, path: Path, offset: int) -> int:
        lines, new_offset = read_new_lines(path, offset)
        feed = builder.feed
        for line in lines:
            if not line:
                continue
            try:
                feed(_loads(line))
            except Exception:
                continue
        return new_offset

    def _cached_summary(self, jsonl: Path, st: os.stat_result) -> SessionSummary | None:
        cached = self._cache.get(str(jsonl))
        if cached and cached.get("size_bytes") == st.st_size and cached.get("mtime") == st.st_mtime:
            try:
                return SessionSummary(**cached)
            except TypeError:
                return None
        return None

    def _parse_summary(self, jsonl: Path, st: os.stat_result) -> SessionSummary:
        key = str(jsonl)
        state = self._sum_states.get(key)
        if state is None or state["offset"] > st.st_size:  # new or truncated/rewritten
            state = {"builder": SummaryBuilder(), "offset": 0}
            self._sum_states[key] = state
        state["offset"] = self._feed_lines(state["builder"], jsonl, state["offset"])
        summary = state["builder"].result(jsonl.stem, key, st.st_size, st.st_mtime)
        self._cache[key] = summary.to_dict()
        self._cache_dirty = True
        return summary

    def _summary(self, jsonl: Path) -> SessionSummary:
        try:
            st = jsonl.stat()
        except OSError:
            return SessionSummary(session_id=jsonl.stem, path=str(jsonl))
        cached = self._cached_summary(jsonl, st)
        if cached is not None:
            return cached
        return self._parse_summary(jsonl, st)

    # -- the one walk every aggregate shares -------------------------------- #

    def _index(self, *, fresh: bool = False) -> list[tuple[Path, list[SessionSummary]]]:
        """Every project directory with its session summaries.

        Cache hits are free. Files that need parsing are counted first so the
        UI can show real progress on a cold start, and the parse itself keeps
        the incremental state so a live session costs only its appended bytes.
        """
        memo = self._index_memo
        if memo is not None and not fresh and time.time() - memo[0] < self.index_ttl:
            return memo[1]
        generation = self._generation
        root = self.projects_root
        result: list[tuple[Path, list[SessionSummary]]] = []
        if not root.is_dir():
            self._index_memo = (time.time(), result)
            return result

        pending: list[tuple[Path, os.stat_result]] = []
        listing: list[tuple[Path, list]] = []
        try:
            with os.scandir(root) as entries:
                project_dirs = sorted(
                    (Path(entry.path) for entry in entries if entry.is_dir(follow_symlinks=False)),
                )
        except OSError:
            project_dirs = []
        for pdir in project_dirs:
            rows: list = []
            for f, st in iter_jsonl_files(pdir, recursive=False):
                cached = self._cached_summary(f, st)
                if cached is None:
                    pending.append((f, st))
                    rows.append(f)          # placeholder, filled below
                else:
                    rows.append(cached)
            listing.append((pdir, rows))

        # Parse what needs parsing, reporting progress when it is worth a
        # status line — a handful of live appends is not.
        total = len(pending)
        report = self.on_progress if total >= 3 else None
        parsed: dict[str, SessionSummary] = {}
        for index, (f, st) in enumerate(pending):
            if report:
                report({"kind": "index", "source": self.label, "provider": "claude",
                        "done": index, "total": total, "file": f.name})
            parsed[str(f)] = self._parse_summary(f, st)
        if report:
            report({"kind": "index", "source": self.label, "provider": "claude",
                    "done": total, "total": total, "file": ""})

        for pdir, rows in listing:
            summaries = [parsed[str(row)] if isinstance(row, Path) else row for row in rows]
            result.append((pdir, summaries))
        self._save_cache()
        if generation == self._generation:
            self._index_memo = (time.time(), result)
        return result

    @staticmethod
    def _project_name(pdir: Path, summaries: list[SessionSummary]) -> tuple[str, str]:
        cwd = next((s.cwd for s in summaries if s.cwd), "")
        name = Path(cwd).name if cwd else pdir.name.lstrip("-").replace("-", "/")
        return cwd, (name or pdir.name)

    # -- projects & sessions ------------------------------------------------ #

    def scan_projects(self) -> list[dict]:
        now = time.time()
        projects: list[dict] = []
        for pdir, summaries in self._index():
            cwd, name = self._project_name(pdir, summaries)
            mem_dir = pdir / "memory"
            memory_count = len([p for p in mem_dir.glob("*.md") if p.name != "MEMORY.md"]) if mem_dir.is_dir() else 0
            projects.append({
                "id": pdir.name,
                "path": cwd,
                "name": name,
                "session_count": len(summaries),
                "active_count": sum(1 for s in summaries if now - s.mtime <= ACTIVE_WINDOW_SECONDS),
                "total_cost": round(sum(s.cost for s in summaries), 4),
                "total_tokens": sum(s.usage.get("total", 0) if isinstance(s.usage, dict) else 0 for s in summaries),
                "active_ms": sum(s.active_ms for s in summaries),
                "tool_errors": sum(s.tool_errors for s in summaries),
                "last_activity": max((s.mtime for s in summaries), default=0.0),
                "memory_count": memory_count,
                "exists": bool(cwd) and Path(cwd).is_dir(),
            })
        projects.sort(key=lambda p: p["last_activity"], reverse=True)
        return projects

    def list_sessions(self, project_id: str) -> list[dict]:
        pdir = self.projects_root / project_id
        if not pdir.is_dir():
            return []
        now = time.time()
        out: list[dict] = []
        for f in pdir.glob("*.jsonl"):
            s = self._summary(f).to_dict()
            s["active"] = now - s["mtime"] <= ACTIVE_WINDOW_SECONDS
            s["protected"] = now - s["mtime"] <= PROTECTED_WINDOW_SECONDS
            out.append(s)
        self._save_cache()
        out.sort(key=lambda s: s["mtime"], reverse=True)
        return out

    def all_sessions(self) -> dict:
        """Every session on the machine as a lightweight record, newest-heaviest
        first — powers the Recent list, Cleanup and the "which sessions to
        include" picker. Built from cached summaries plus each session's
        on-disk footprint (transcript + ancillary tasks/history/image/env data).
        """
        now = time.time()
        assets = self._asset_index()
        out: list[dict] = []
        for pdir, summaries in self._index():
            cwd, pname = self._project_name(pdir, summaries)
            for s in summaries:
                footprint = assets.get(s.session_id) or _EMPTY_ASSETS
                out.append({
                    "project_id": pdir.name,
                    "project_name": pname,
                    "project_path": cwd,
                    "session_id": s.session_id,
                    "title": s.title or s.first_prompt or "Untitled session",
                    "first_prompt": s.first_prompt,
                    "cost": round(s.cost, 4),
                    "tokens": (s.usage or {}).get("total", 0) if isinstance(s.usage, dict) else 0,
                    "user_messages": s.user_messages,
                    "assistant_messages": s.assistant_messages,
                    "tool_calls": s.tool_calls,
                    "tool_errors": s.tool_errors,
                    "compactions": s.compactions,
                    "active_ms": s.active_ms,
                    "size_bytes": s.size_bytes,
                    "extra_bytes": footprint["total"],
                    "asset_bytes": footprint,
                    "mtime": s.mtime,
                    "created": s.created,
                    "active": now - s.mtime <= ACTIVE_WINDOW_SECONDS,
                    "protected": now - s.mtime <= PROTECTED_WINDOW_SECONDS,
                    "has_subagents": s.has_subagents,
                    "context_pct": s.context_pct,
                    "models": [m for m in s.models if m != "<synthetic>"],
                })
        out.sort(key=lambda x: x["size_bytes"] + x["extra_bytes"], reverse=True)
        total_bytes = sum(x["size_bytes"] + x["extra_bytes"] for x in out)
        return {"sessions": out, "home": str(self.home), "total_bytes": total_bytes}

    def summaries_for(self, items: list) -> list[dict]:
        """Cached summary dicts for a list of ``{project_id, session_id}`` — the
        context an assistant job digests (never full transcripts)."""
        out: list[dict] = []
        for it in items or []:
            pid = (it or {}).get("project_id")
            sid = (it or {}).get("session_id")
            if not pid or not sid:
                continue
            f = self.projects_root / pid / f"{sid}.jsonl"
            if f.is_file():
                out.append(self._summary(f).to_dict())
        return out

    # -- ancillary footprint ------------------------------------------------- #

    def _asset_index(self) -> dict[str, dict]:
        """Per-session ancillary bytes, from one listing of each asset root.

        Listing the roots once and walking only the directories that exist
        replaces five probes per session with a handful of scandir calls,
        which matters most over a WSL UNC path where every stat is a round
        trip. The result is memoised because these directories change slowly.
        """
        memo = self._asset_memo
        # A remote source gets a long index TTL; its asset walk is slower still.
        ttl = max(ASSET_TTL_SECONDS, self.index_ttl)
        if memo is not None and self.index_ttl and time.time() - memo[0] < ttl:
            return memo[1]
        result: dict[str, dict] = {}
        roots = (
            ("tasks", self.home / "tasks"),
            ("file_history", self.home / "file-history"),
            ("images", self.home / "uploads"),
            ("images", self.home / "image-cache"),
            ("session_env", self.home / "session-env"),
        )
        for kind, root in roots:
            try:
                with os.scandir(root) as it:
                    entries = [entry for entry in it if entry.is_dir(follow_symlinks=False)]
            except OSError:
                continue
            for entry in entries:
                bucket = result.setdefault(entry.name, {"tasks": 0, "file_history": 0, "images": 0, "session_env": 0})
                bucket[kind] += _dir_size(Path(entry.path))
        for bucket in result.values():
            bucket["total"] = bucket["tasks"] + bucket["file_history"] + bucket["images"] + bucket["session_env"]
        self._asset_memo = (time.time(), result)
        return result

    def _session_footprint(self, session_id: str) -> int:
        """Bytes of a session's ancillary data (tasks, file-history, image-cache,
        session-env) — the extra space a purge deletion reclaims."""
        return self._session_asset_bytes(session_id)["total"]

    def _session_asset_bytes(self, session_id: str) -> dict:
        """Per-category ancillary footprint for one session."""
        result = {
            "tasks": _dir_size(self.home / "tasks" / session_id),
            "file_history": _dir_size(self.home / "file-history" / session_id),
            "images": sum(_dir_size(root / session_id) for root in self._image_roots()),
            "session_env": _dir_size(self.home / "session-env" / session_id),
        }
        result["total"] = sum(result.values())
        return result

    def storage_assets(self) -> dict:
        """Inventory removable Claude ancillary data without reading contents.

        Asset groups are direct, path-guardable directories.  The UI can filter
        images, task state, file checkpoints, environments, and scratchpads
        independently of transcript deletion.  A group is marked orphaned when
        no current transcript has the same session id.
        """
        now = time.time()
        by_session: dict[str, dict] = {}
        for pdir, summaries in self._index():
            cwd, project_name = self._project_name(pdir, summaries)
            for summary in summaries:
                by_session[summary.session_id] = {
                    "project_id": pdir.name,
                    "project_name": project_name,
                    "title": summary.title or summary.first_prompt or "Untitled session",
                    "protected": now - summary.mtime <= PROTECTED_WINDOW_SECONDS,
                }
        items: list[dict] = []

        def add(kind: str, path: Path, session_id: str) -> None:
            size, count, mtime = _dir_stats(path)
            if not size and not count:
                return
            session = by_session.get(session_id)
            items.append({
                "provider": "claude",
                "kind": kind,
                "path": str(path),
                "session_id": session_id,
                "project_id": session.get("project_id", "") if session else "",
                "project_name": session.get("project_name", "Unknown session") if session else "Unknown session",
                "title": session.get("title", "Orphaned session data") if session else "Orphaned session data",
                "size_bytes": size,
                "file_count": count,
                "mtime": mtime,
                "orphaned": session is None,
                "protected": bool(
                    (session and session.get("protected"))
                    or (mtime and time.time() - mtime <= PROTECTED_WINDOW_SECONDS)
                ),
            })

        categories = (
            ("uploads", self.home / "uploads"),
            ("legacy_images", self.home / "image-cache"),
            ("file_history", self.home / "file-history"),
            ("tasks", self.home / "tasks"),
            ("session_env", self.home / "session-env"),
        )
        for kind, root in categories:
            if not root.is_dir():
                continue
            try:
                children = list(root.iterdir())
            except OSError:
                children = []
            for child in children:
                if child.is_dir():
                    add(kind, child, child.name)

        # Scratchpads live outside ~/.claude, below a generated claude-* tree.
        # Only the exact */<session>/scratchpad leaf is surfaced.
        seen: set[str] = set()
        for temp_root in self._temp_roots:
            for path in temp_root.glob("claude-*/*/*/scratchpad"):
                try:
                    key = str(path.resolve())
                except OSError:
                    continue
                if key in seen or not path.is_dir():
                    continue
                seen.add(key)
                add("scratchpad", path, path.parent.name)

        items.sort(key=lambda item: item["size_bytes"], reverse=True)
        by_kind: dict[str, dict] = {}
        for item in items:
            bucket = by_kind.setdefault(item["kind"], {"bytes": 0, "groups": 0, "files": 0})
            bucket["bytes"] += item["size_bytes"]
            bucket["groups"] += 1
            bucket["files"] += item["file_count"]
        return {
            "provider": "claude",
            "items": items,
            "by_kind": by_kind,
            "total_bytes": sum(item["size_bytes"] for item in items),
            "orphaned_bytes": sum(item["size_bytes"] for item in items if item["orphaned"]),
        }

    def _image_roots(self) -> tuple[Path, Path]:
        """Current uploads plus the legacy image-cache location."""
        return (self.home / "uploads", self.home / "image-cache")

    def project_path(self, project_id: str) -> str:
        pdir = self.projects_root / project_id
        for f in pdir.glob("*.jsonl"):
            s = self._summary(f)
            if s.cwd:
                return s.cwd
        return ""

    def release_detail(self, project_id: str, session_id: str) -> None:
        """Release a reconstructed transcript when its inspector is closed."""
        key = str(self.projects_root / project_id / f"{session_id}.jsonl")
        self._detail_states.pop(key, None)

    # -- session detail (incremental, paged) --------------------------------- #

    def _detail_builder(self, jsonl: Path) -> DetailBuilder | None:
        """Return the up-to-date incremental builder for a transcript."""
        key = str(jsonl)
        try:
            size = jsonl.stat().st_size
        except OSError:
            return None
        state = self._detail_states.get(key)
        if state is None or state["offset"] > size:
            state = {"builder": DetailBuilder(), "offset": 0, "used": 0.0}
            self._detail_states[key] = state
            # Evict least-recently-used states beyond the cap.
            if len(self._detail_states) > MAX_DETAIL_STATES:
                oldest = min(
                    (k for k in self._detail_states if k != key),
                    key=lambda k: self._detail_states[k]["used"],
                    default=None,
                )
                if oldest:
                    del self._detail_states[oldest]
        state["offset"] = self._feed_lines(state["builder"], jsonl, state["offset"])
        state["used"] = time.time()
        return state["builder"]

    def detail(self, jsonl: Path, *, tail: int = 60) -> dict:
        """Aggregates + the last `tail` transcript events (paged elsewhere)."""
        b = self._detail_builder(jsonl)
        if b is None:
            return {"events": [], "error": "not found"}
        out = b.meta()
        out["events"], out["events_start"] = b.tail(tail)
        return out

    def detail_meta(self, jsonl: Path) -> dict:
        """Aggregates only — what a live refresh needs, without the tail."""
        b = self._detail_builder(jsonl)
        if b is None:
            return {"error": "not found"}
        return b.meta()

    def transcript_before(self, jsonl: Path, before: int, count: int) -> dict:
        b = self._detail_builder(jsonl)
        if b is None:
            return {"events": [], "start": 0}
        events, start = b.page_before(before, count)
        return {"events": events, "start": start, "total": len(b.events)}

    def transcript_after(self, jsonl: Path, after: int) -> dict:
        b = self._detail_builder(jsonl)
        if b is None:
            return {"events": [], "start": 0}
        events, start = b.page_after(after)
        return {"events": events, "start": start, "total": len(b.events)}

    # -- memory ------------------------------------------------------------- #

    def get_memory(self, project_id: str) -> dict:
        mem_dir = self.projects_root / project_id / "memory"
        index = ""
        files: list[dict] = []
        if mem_dir.is_dir():
            idx = mem_dir / "MEMORY.md"
            if idx.is_file():
                index = idx.read_text("utf-8", errors="replace")
            for f in sorted(mem_dir.glob("*.md")):
                if f.name == "MEMORY.md":
                    continue
                text = f.read_text("utf-8", errors="replace")
                meta = _parse_frontmatter(text)
                try:
                    st = f.stat()
                    size, mtime = st.st_size, st.st_mtime
                except OSError:
                    size, mtime = 0, 0.0
                files.append(
                    {
                        "name": f.name,
                        "path": str(f),
                        "title": meta.get("name", f.stem),
                        "description": meta.get("description", ""),
                        "type": meta.get("type", ""),
                        "size": size,
                        "mtime": mtime,
                        "content": text,
                    }
                )
        return {"index": index, "index_path": str(mem_dir / "MEMORY.md"), "dir": str(mem_dir), "files": files}

    # -- tasks -------------------------------------------------------------- #

    def get_tasks(self, session_id: str) -> list[dict]:
        tdir = self.home / "tasks" / session_id
        if not tdir.is_dir():
            return []
        tasks: list[dict] = []
        for f in tdir.glob("*.json"):
            try:
                tasks.append(json.loads(f.read_text("utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        tasks.sort(key=lambda t: str(t.get("id", "")))
        return tasks

    # -- workspace (scratchpad + background task outputs) ------------------- #

    def get_scratchpad(self, project_path: str, session_id: str) -> dict:
        base = None
        encoded = paths.encode_project_path(project_path)
        for root in self._temp_roots:
            try:
                base = next((p for p in root.glob(f"claude-*/{encoded}/{session_id}") if p.is_dir()), None)
            except OSError:
                base = None
            if base:
                break
        result = {"dir": str(base) if base else "", "exists": bool(base), "files": []}
        if not base:
            return result
        files = []
        for f in base.rglob("*"):
            if f.is_dir() or "__pycache__" in f.parts:
                continue
            try:
                st = f.stat()
            except OSError:
                continue
            files.append(
                {
                    "name": str(f.relative_to(base)),
                    "path": str(f),
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "ext": f.suffix.lstrip("."),
                }
            )
        files.sort(key=lambda x: x["mtime"], reverse=True)
        result["files"] = files
        return result

    # -- images ------------------------------------------------------------- #

    def get_images(self, session_id: str) -> list[dict]:
        out = []
        seen: set[str] = set()
        for root in self._image_roots():
            d = root / session_id
            if not d.is_dir():
                continue
            for f in sorted(d.iterdir()):
                if f.suffix.lower() not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
                    continue
                try:
                    key = str(f.resolve())
                    if key in seen:
                        continue
                    seen.add(key)
                    st = f.stat()
                except OSError:
                    continue
                out.append({"name": f.name, "path": str(f), "size": st.st_size, "mtime": st.st_mtime, "kind": root.name})
        return out

    # -- file history ------------------------------------------------------- #

    def get_file_history(self, session_id: str) -> dict:
        d = self.home / "file-history" / session_id
        count = 0
        total = 0
        if d.is_dir():
            try:
                with os.scandir(d) as it:
                    for entry in it:
                        if entry.is_file(follow_symlinks=False):
                            count += 1
                            try:
                                total += entry.stat(follow_symlinks=False).st_size
                            except OSError:
                                pass
            except OSError:
                pass
        return {"dir": str(d), "count": count, "bytes": total}

    # -- shells & environments (monitor) ------------------------------------ #

    def get_shells(self) -> dict:
        home = self.home
        snaps = []
        sdir = self.home / "shell-snapshots"
        if sdir.is_dir():
            for f in sdir.iterdir():
                if not f.is_file():
                    continue
                try:
                    st = f.stat()
                except OSError:
                    continue
                snaps.append({"name": f.name, "path": str(f), "size": st.st_size, "mtime": st.st_mtime})
            snaps.sort(key=lambda x: x["mtime"], reverse=True)
        envs = []
        edir = home / "session-env"
        if edir.is_dir():
            for d in edir.iterdir():
                if not d.is_dir():
                    continue
                try:
                    mtime = d.stat().st_mtime
                except OSError:
                    mtime = 0.0
                envs.append({"session_id": d.name, "path": str(d), "mtime": mtime})
            envs.sort(key=lambda x: x["mtime"], reverse=True)
        return {"snapshots": snaps[:20], "envs": envs[:20]}

    # -- global stats (all sessions, all projects) --------------------------- #

    def global_stats(self) -> dict:
        """Aggregate analytics across every session on the machine.

        Reads only cached summaries (cheap after the first scan). Per-day
        figures come from each session's own ledger, so a session that ran
        across three days is charged to the days the work actually happened
        on rather than to the day its file was last touched.
        """
        totals = pricing.Usage()
        by_model: dict[str, pricing.Usage] = {}
        tools: Counter[str] = Counter()
        days: dict[str, dict] = {}
        sessions_by_day: Counter[str] = Counter()
        cost = 0.0
        sessions = active = prompts = turns = tool_calls = subagent_sessions = 0
        active_ms = tool_errors = compactions = 0
        first_activity = ""
        heat = [[0] * 24 for _ in range(7)]
        by_project: list[dict] = []
        skills: dict[str, dict] = {}
        agents: dict[str, dict] = {}
        commands: dict[str, dict] = {}
        kills = interrupts = 0
        cache_savings = 0.0
        project_days: dict[str, dict[str, float]] = {}
        now = time.time()

        def roll(table: dict, counts: dict, project_name: str, when: float) -> None:
            for name, n in (counts or {}).items():
                row = table.setdefault(name, {"count": 0, "sessions": 0, "projects": set(), "last": 0.0})
                row["count"] += int(n or 0)
                row["sessions"] += 1
                row["projects"].add(project_name)
                row["last"] = max(row["last"], when)

        def day_bucket(day: str) -> dict:
            bucket = days.get(day)
            if bucket is None:
                bucket = {"d": day, "cost": 0.0, "tokens": 0, "turns": 0, "prompts": 0,
                          "errors": 0, "active_ms": 0, "sessions": 0, "models": {}}
                days[day] = bucket
            return bucket

        for pdir, summaries in self._index():
            cwd, name = self._project_name(pdir, summaries)
            project = {"id": pdir.name, "name": name, "path": cwd, "sessions": len(summaries),
                       "cost": 0.0, "tokens": 0, "turns": 0, "active_ms": 0, "errors": 0,
                       "last_activity": 0.0, "compactions": 0, "skills": 0, "agents": 0,
                       "kills": 0, "interrupts": 0}
            for s in summaries:
                sessions += 1
                cost += s.cost
                prompts += s.user_messages
                turns += s.assistant_messages
                tool_calls += s.tool_calls
                active_ms += s.active_ms
                tool_errors += s.tool_errors
                compactions += s.compactions
                kills += s.kills
                interrupts += s.interrupts
                roll(skills, s.skills, pdir.name, s.mtime)
                roll(agents, s.agents, pdir.name, s.mtime)
                roll(commands, s.commands, pdir.name, s.mtime)
                project["skills"] += sum((s.skills or {}).values())
                project["agents"] += sum((s.agents or {}).values())
                project["kills"] += s.kills
                project["interrupts"] += s.interrupts
                if s.has_subagents:
                    subagent_sessions += 1
                if now - s.mtime <= ACTIVE_WINDOW_SECONDS:
                    active += 1
                if s.created and (not first_activity or s.created < first_activity):
                    first_activity = s.created
                u = s.usage or {}
                totals.add(pricing.Usage(
                    input=u.get("input", 0), output=u.get("output", 0),
                    cache_read=u.get("cache_read", 0), cache_write=u.get("cache_write", 0)))
                for m, ud in (s.usage_by_model or {}).items():
                    if m in ("unknown", "<synthetic>"):
                        continue
                    bm = by_model.setdefault(m, pricing.Usage())
                    bm.add(pricing.Usage(
                        input=ud.get("input", 0), output=ud.get("output", 0),
                        cache_read=ud.get("cache_read", 0), cache_write=ud.get("cache_write", 0)))
                    cache_savings += pricing.cache_savings(int(ud.get("cache_read", 0) or 0), m)
                for tool_name, c in (s.tool_counts or {}).items():
                    tools[tool_name] += c
                for slot, count in (s.activity or {}).items():
                    try:
                        wday, hour = slot.split(":")
                        heat[int(wday)][int(hour)] += int(count)
                    except (ValueError, IndexError):
                        continue
                for day, row in (s.daily or {}).items():
                    bucket = day_bucket(day)
                    bucket["cost"] += float(row.get("c", 0) or 0)
                    bucket["tokens"] += int(row.get("t", 0) or 0)
                    bucket["turns"] += int(row.get("n", 0) or 0)
                    bucket["prompts"] += int(row.get("p", 0) or 0)
                    bucket["errors"] += int(row.get("e", 0) or 0)
                    bucket["active_ms"] += int(row.get("a", 0) or 0)
                    bucket["sessions"] += 1
                    for model, model_cost in (row.get("m") or {}).items():
                        bucket["models"][model] = bucket["models"].get(model, 0.0) + float(model_cost or 0)
                    if row.get("c"):
                        pdays = project_days.setdefault(pdir.name, {})
                        pdays[day] = pdays.get(day, 0.0) + float(row.get("c") or 0)
                if s.mtime:
                    sessions_by_day[time.strftime("%Y-%m-%d", time.localtime(s.mtime))] += 1
                project["cost"] += s.cost
                project["tokens"] += int(u.get("total", 0) or 0)
                project["turns"] += s.assistant_messages
                project["active_ms"] += s.active_ms
                project["errors"] += s.tool_errors
                project["compactions"] += s.compactions
                project["last_activity"] = max(project["last_activity"], s.mtime)
            project["cost"] = round(project["cost"], 4)
            by_project.append(project)

        self._save_cache()
        # last 90 calendar days, zero-filled — the frontend slices what it needs
        by_day = []
        daily = []
        for i in range(DAY_HISTORY - 1, -1, -1):
            d = time.strftime("%Y-%m-%d", time.localtime(now - i * 86400))
            by_day.append([d, sessions_by_day.get(d, 0)])
            row = days.get(d) or {"d": d, "cost": 0.0, "tokens": 0, "turns": 0, "prompts": 0,
                                  "errors": 0, "active_ms": 0, "sessions": 0, "models": {}}
            row = dict(row)
            row["cost"] = round(row["cost"], 4)
            row["models"] = {m: round(c, 4) for m, c in row["models"].items()}
            daily.append(row)
        usage_total = asdict(totals)
        usage_total["total"] = totals.total
        by_project.sort(key=lambda p: p["last_activity"], reverse=True)

        def rolled(table: dict) -> dict:
            return {name: {**row, "projects": len(row["projects"])} for name, row in table.items()}

        # Spend per day for the heaviest projects, so the dashboard can stack
        # the daily chart by project as well as by model. The tail folds into
        # "other" rather than becoming a ninth colour.
        heavy = sorted(project_days, key=lambda pid: -sum(project_days[pid].values()))[:7]
        window_days = {row["d"] for row in daily}
        project_daily: dict[str, dict] = {pid: {} for pid in heavy}
        other: dict[str, float] = {}
        for pid, pdays in project_days.items():
            target = project_daily[pid] if pid in project_daily else other
            for day, value in pdays.items():
                if day in window_days:
                    target[day] = round(target.get(day, 0.0) + value, 4)
        if other:
            project_daily["other"] = other

        return {
            "cost": round(cost, 4),
            "cache_savings": round(cache_savings, 4),
            "project_daily": project_daily,
            "usage": usage_total,
            "sessions": sessions,
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
            "by_model": {
                m: {**asdict(u), "total": u.total, "cost": round(pricing.cost_for(u, m), 4)}
                for m, u in by_model.items()
            },
            "tool_counts": dict(tools.most_common(24)),
            "sessions_by_day": by_day,
            "daily": daily,
            "activity": heat,
            "by_project": by_project,
        }

    # -- trace: skills, agents, kills and interruptions across sessions ------- #

    def trace_events(self, limit: int = 500) -> list[dict]:
        """Every traced moment on the machine, newest first, with its session.

        Built from the cached per-session traces, so it costs one walk of the
        summaries and never opens a transcript.
        """
        out: list[dict] = []
        for pdir, summaries in self._index():
            cwd, pname = self._project_name(pdir, summaries)
            for s in summaries:
                for row in s.trace or []:
                    out.append({
                        **row,
                        "session_id": s.session_id,
                        "project_id": pdir.name,
                        "project_name": pname,
                        "title": s.title or s.first_prompt or "Untitled session",
                    })
        out.sort(key=lambda row: row.get("t", 0), reverse=True)
        return out[:limit]

    # -- global search ------------------------------------------------------- #

    def search_all(self, query: str) -> dict:
        q = query.lower().strip()
        if not q:
            return {"sessions": [], "prompts": []}
        sessions = []
        for key, s in self._cache.items():
            hay = " ".join((s.get("title", ""), s.get("first_prompt", ""), s.get("cwd", ""), s.get("session_id", ""))).lower()
            if q in hay:
                p = Path(key)
                sessions.append(
                    {
                        "project_id": p.parent.name,
                        "project_name": Path(s.get("cwd", "")).name or p.parent.name,
                        "session_id": s.get("session_id", ""),
                        "title": s.get("title") or s.get("first_prompt", ""),
                        "cost": s.get("cost", 0),
                        "mtime": s.get("mtime", 0),
                    }
                )
        sessions.sort(key=lambda x: x["mtime"], reverse=True)

        self._refresh_history_index()
        prompts = []
        for rec in reversed(self._history_records):
            display = rec.get("display", "")
            if q not in display.lower():
                continue
            project = rec.get("project", "")
            prompts.append(
                {
                    "display": display[:220],
                    "project": project,
                    "project_name": Path(project).name if project else "",
                    "project_id": paths.encode_project_path(project) if project else "",
                    "session_id": rec.get("sessionId", ""),
                    "timestamp": rec.get("timestamp", 0),
                }
            )
            if len(prompts) >= 50:
                break
        return {"sessions": sessions[:50], "prompts": prompts}

    def _refresh_history_index(self) -> None:
        """Incrementally cache prompt history instead of rereading it per query."""
        hist = self.home / "history.jsonl"
        try:
            size = hist.stat().st_size
        except OSError:
            self._history_records = []
            self._history_offset = 0
            return
        if size < self._history_offset:
            self._history_records = []
            self._history_offset = 0
        lines, self._history_offset = read_new_lines(hist, self._history_offset)
        for line in lines:
            if not line:
                continue
            try:
                rec = _loads(line)
            except Exception:
                continue
            if isinstance(rec, dict) and rec.get("display"):
                self._history_records.append(rec)

    # -- settings & statusline --------------------------------------------- #

    def get_settings(self) -> dict:
        merged: dict = {}
        raw: list[dict] = []
        for f in (self.home / "settings.json", self.home / "settings.local.json"):
            if f.is_file():
                try:
                    data = json.loads(f.read_text("utf-8"))
                except (OSError, json.JSONDecodeError):
                    data = {}
                merged.update(data)
                raw.append({"name": f.name, "path": str(f), "data": data})
        statusline = merged.get("statusLine", {})
        sl_script = None
        cmd = statusline.get("command", "") if isinstance(statusline, dict) else ""
        if isinstance(cmd, str) and cmd:
            token = cmd.replace("bash ", "").replace("~", str(Path.home())).split()[0] if cmd.split() else ""
            sp = Path(token).expanduser() if token else None
            if sp and sp.is_file():
                sl_script = {"path": str(sp), "content": sp.read_text("utf-8", errors="replace")}
        return {
            "merged": merged,
            "files": raw,
            "home": str(self.home),
            "statusline_script": sl_script,
            "live": self.get_statusline_live(),
        }

    def get_statusline_live(self) -> dict | None:
        f = self.home / ".asm-statusline.json"
        if not f.is_file():
            f = self.home / ".csm-statusline.json"
        if not f.is_file():
            return None
        try:
            data = json.loads(f.read_text("utf-8"))
            data["_captured_mtime"] = f.stat().st_mtime
            return data
        except (OSError, json.JSONDecodeError):
            return None


_EMPTY_ASSETS = {"tasks": 0, "file_history": 0, "images": 0, "session_env": 0, "total": 0}


def _dir_size(d: Path) -> int:
    """Total size of files under ``d`` (bounded recursion), 0 if missing."""
    total = 0
    try:
        with os.scandir(d) as it:
            for e in it:
                try:
                    if e.is_file(follow_symlinks=False):
                        total += e.stat(follow_symlinks=False).st_size
                    elif e.is_dir(follow_symlinks=False):
                        total += _dir_size(Path(e.path))
                except OSError:
                    continue
    except OSError:
        pass
    return total


def _dir_stats(d: Path) -> tuple[int, int, float]:
    """Return ``(bytes, files, newest_mtime)`` without following symlinks."""
    total = count = 0
    newest = 0.0
    try:
        with os.scandir(d) as it:
            for entry in it:
                try:
                    if entry.is_file(follow_symlinks=False):
                        stat = entry.stat(follow_symlinks=False)
                        total += stat.st_size
                        count += 1
                        newest = max(newest, stat.st_mtime)
                    elif entry.is_dir(follow_symlinks=False):
                        child_total, child_count, child_mtime = _dir_stats(Path(entry.path))
                        total += child_total
                        count += child_count
                        newest = max(newest, child_mtime)
                except OSError:
                    continue
    except OSError:
        pass
    return total, count, newest


def _parse_frontmatter(text: str) -> dict:
    meta: dict[str, str] = {}
    if not text.startswith("---"):
        return meta
    for line in text.splitlines()[1:]:
        if line.strip() == "---":
            break
        if ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip()
            if key in ("name", "description", "type", "node_type") and val:
                meta[key.replace("node_type", "type")] = val
    return meta
