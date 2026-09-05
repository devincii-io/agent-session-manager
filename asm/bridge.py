"""QWebChannel bridge: the single object exposed to the JavaScript frontend.

Two ways in, one way out:

* ``invoke(request_id, method, args_json)`` is what the frontend uses. It
  returns at once; the named method runs on a worker thread and its JSON
  result comes back through the ``replied`` signal. The GUI thread never
  blocks on a scan, so the window stays responsive and filesystem events keep
  flowing while a cold index or a WSL walk is under way. Anything that must
  touch Qt objects (the assistant's ``QProcess``, the window) runs inline on
  the GUI thread instead.
* The plain slots below still exist and still return JSON strings, for older
  callers and for tests. They run synchronously on whichever thread calls them.

Every scanner is wrapped in a lock, so two workers never interleave inside one
scanner's incremental state, while a Claude parse and a Codex parse can run at
the same time. Signals that face the web channel are always emitted from the
GUI thread: worker threads hand their payloads over through an internal queued
signal rather than emitting to the channel directly.

Filesystem changes are debounced into a single ``dataChanged`` signal so the UI
can refresh live without redrawing on every byte appended to a transcript.
"""

from __future__ import annotations

import json
import os
import platform
import queue
import threading
import time
from collections import Counter
from pathlib import Path
from uuid import uuid4

from PySide6.QtCore import QObject, QProcess, Qt, QTimer, Signal, Slot

from . import __version__, actions, assistant, paths
from . import update as updater
from .scanner import INDEX_TTL_SECONDS, Scanner
from .codex_scanner import CodexScanner
from .sources import Source, discover_sources, local_source, refresh_sources, source_by_id
from .watcher import Watcher

WORKER_THREADS = 2
PROGRESS_INTERVAL = 0.08  # seconds between progress emits per source

#: Aggregate work that can wait behind whatever the user is looking at.
_BACKGROUND = {
    "getProviderGlobalStats", "getProviderAllSessions", "getStorageAssets", "getTrace",
    "searchProvider", "getSources", "refreshSources", "getAllSessions", "getGlobalStats",
}
#: Methods that touch Qt objects, or are trivial; they run inline on the GUI thread.
_MAIN_THREAD = {
    "getAppInfo", "startAssistant", "cancelAssistant", "windowMinimize", "windowClose",
    "leaveSession", "checkForUpdate", "installUpdate", "openReleasePage",
}
#: When a newer request for one of these arrives before an older one has
#: started, the older one is answered as stale without doing its work.
_COALESCE = {
    "getProviderSessionDetail", "getSessionMeta", "getProviderSessions", "getProviderOverview",
    "getProviderGlobalStats", "getProviderAllSessions", "searchProvider", "getTrace",
}


def _j(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


class _Guarded:
    """A scanner behind a re-entrant lock, so a worker never interleaves with
    another inside its incremental state."""

    def __init__(self, target) -> None:
        self._target = target
        self._lock = threading.RLock()

    def __getattr__(self, name):
        attr = getattr(self._target, name)
        if not callable(attr):
            return attr

        def call(*args, **kwargs):
            with self._lock:
                return attr(*args, **kwargs)

        return call


class Bridge(QObject):
    dataChanged = Signal(str)      # emitted (debounced) when the filesystem changes
    assistantEvent = Signal(str)   # async result of a claude-CLI job (JSON)
    updateEvent = Signal(str)      # async release check/download result (JSON)
    replied = Signal(str, str)     # (request_id, JSON) — the answer to invoke()
    progress = Signal(str)         # JSON: indexing progress for the status bar

    # Worker threads hand results to the GUI thread through these; the
    # queued connection is what keeps the web channel single-threaded.
    _deliverReply = Signal(str, str)
    _deliverEvent = Signal(str, str)

    def __init__(self, scanner: Scanner, watcher: Watcher) -> None:
        super().__init__()
        local = local_source()
        self._local_source_id = local.id
        self._scanner = _Guarded(scanner)
        self._codex = _Guarded(CodexScanner(on_progress=self._on_progress, index_ttl=INDEX_TTL_SECONDS))
        scanner.on_progress = self._on_progress
        scanner.index_ttl = INDEX_TTL_SECONDS
        self._source_scanners: dict[str, tuple[_Guarded, _Guarded]] = {
            local.id: (self._scanner, self._codex)
        }
        self._source_lock = threading.Lock()
        self._watcher = watcher
        self._window = None  # set by the application shell
        self._open_session: tuple[str, str, str, str] | None = None
        self._open_lock = threading.Lock()
        self._pending_reason: str | None = None
        self._jobs: dict[str, tuple[QProcess, str, QTimer]] = {}
        self._update_busy = False
        self._progress_at: dict[str, float] = {}

        self._deliverReply.connect(self._on_deliver_reply, Qt.ConnectionType.QueuedConnection)
        self._deliverEvent.connect(self._on_deliver_event, Qt.ConnectionType.QueuedConnection)

        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(220)
        self._debounce.timeout.connect(self._flush)
        # A trailing debounce alone can starve forever while a busy session
        # writes continuously. This timer guarantees a bounded update cadence.
        self._max_wait = QTimer(self)
        self._max_wait.setSingleShot(True)
        self._max_wait.setInterval(1000)
        self._max_wait.timeout.connect(self._flush)
        self._watcher.fileEvent.connect(self._on_fs_event)

        # -- the worker pool ------------------------------------------------ #
        self._queue: queue.PriorityQueue = queue.PriorityQueue()
        self._seq = 0
        self._latest: dict[str, str] = {}
        self._workers = [
            threading.Thread(target=self._work, name=f"asm-worker-{index}", daemon=True)
            for index in range(WORKER_THREADS)
        ]
        for worker in self._workers:
            worker.start()

    # -- async lane --------------------------------------------------------- #

    @Slot(str, str, str)
    def invoke(self, request_id: str, method: str, args_json: str) -> None:
        """Run ``method`` off the GUI thread; the result arrives via ``replied``."""
        try:
            args = json.loads(args_json) if args_json else []
        except json.JSONDecodeError:
            args = []
        if not isinstance(args, list):
            args = [args]
        target = getattr(self, method, None) if not method.startswith("_") else None
        if target is None or not callable(target):
            self.replied.emit(request_id, _j({"ok": False, "error": f"unknown method {method}"}))
            return
        if method in _MAIN_THREAD:
            try:
                result = target(*args)
            except Exception as exc:  # noqa: BLE001
                result = _j({"ok": False, "error": str(exc)})
            self.replied.emit(request_id, result if isinstance(result, str) else _j(result))
            return
        if method in _COALESCE:
            self._latest[method] = request_id
        priority = 1 if method in _BACKGROUND else 0
        self._seq += 1
        self._queue.put((priority, self._seq, request_id, method, args))

    def _work(self) -> None:
        while True:
            _priority, _seq, request_id, method, args = self._queue.get()
            if method is None:
                return
            if method in _COALESCE and self._latest.get(method) != request_id:
                self._deliverReply.emit(request_id, _j({"stale": True}))
                continue
            try:
                result = getattr(self, method)(*args)
            except Exception as exc:  # noqa: BLE001
                result = _j({"ok": False, "error": str(exc)})
            if not isinstance(result, str):
                result = _j(result)
            self._deliverReply.emit(request_id, result)

    def _on_deliver_reply(self, request_id: str, payload: str) -> None:
        self.replied.emit(request_id, payload)

    def _on_deliver_event(self, kind: str, payload: str) -> None:
        if kind == "progress":
            self.progress.emit(payload)
        elif kind == "update":
            self.updateEvent.emit(payload)

    def _on_progress(self, event: dict) -> None:
        """Called by a scanner on a worker thread while it parses cold files."""
        key = f"{event.get('source')}:{event.get('provider')}"
        now = time.monotonic()
        finished = event.get("done") == event.get("total")
        if not finished and now - self._progress_at.get(key, 0.0) < PROGRESS_INTERVAL:
            return
        self._progress_at[key] = now
        self._deliverEvent.emit("progress", _j(event))

    def shutdown(self) -> None:
        """Flush caches and let the workers exit; called on application quit."""
        for _index in self._workers:
            self._queue.put((-1, 0, "", None, []))
        for pair in list(self._source_scanners.values()):
            for scanner in pair:
                try:
                    scanner.flush()
                except Exception:
                    pass

    # -- source registry --------------------------------------------------- #

    def _source_pair(self, source_id: str) -> tuple[Source, _Guarded, _Guarded] | None:
        source = source_by_id(source_id, resolve=True)
        if source is None or not source.available or not source.resolved:
            return None
        with self._source_lock:
            pair = self._source_scanners.get(source.id)
            if pair is None:
                pair = (
                    _Guarded(Scanner(source.claude_home, cache_namespace=source.id,
                                     temp_roots=source.temp_roots, on_progress=self._on_progress,
                                     index_ttl=INDEX_TTL_SECONDS)),
                    _Guarded(CodexScanner(source.codex_home, cache_namespace=source.id,
                                          on_progress=self._on_progress, index_ttl=INDEX_TTL_SECONDS)),
                )
                self._source_scanners[source.id] = pair
        return source, pair[0], pair[1]

    def _scope(self, scope_json: str) -> list[tuple[Source, _Guarded, _Guarded]]:
        try:
            requested = json.loads(scope_json) if scope_json else [self._local_source_id]
        except (json.JSONDecodeError, TypeError):
            requested = [scope_json or self._local_source_id]
        if not isinstance(requested, list) or not requested:
            requested = [self._local_source_id]
        result = []
        for source_id in requested:
            pair = self._source_pair(str(source_id))
            if pair is not None:
                result.append(pair)
        return result

    @staticmethod
    def _project_id(source_id: str, native_id: str) -> str:
        return f"{source_id}::{native_id}"

    def _split_project_id(self, project_id: str) -> tuple[str, str]:
        if "::" in project_id:
            return tuple(project_id.split("::", 1))  # type: ignore[return-value]
        return self._local_source_id, project_id

    def _decorate(self, item: dict, source: Source, provider: str, *, project: bool = False) -> dict:
        result = dict(item)
        result.update({
            "source_id": source.id, "source_label": source.label,
            "source_kind": source.kind, "source_writable": source.writable,
            "provider": provider,
        })
        if project:
            result["native_id"] = item.get("id", "")
            result["id"] = self._project_id(source.id, str(item.get("id", "")))
            if source.kind == "wsl" and str(item.get("path", "")).startswith("/"):
                result["exists"] = source.available
        elif item.get("project_id"):
            result["project_id"] = self._project_id(source.id, str(item["project_id"]))
        return result

    # -- filesystem → UI ---------------------------------------------------- #

    def _on_fs_event(self, path: str) -> None:
        # Statusline capture rewrites constantly while Claude runs; route it as
        # a cheap "statusline" tick so the UI doesn't do a full data refresh.
        reason = self._classify_path(path)
        if self._pending_reason is None:
            self._pending_reason = reason
        elif self._pending_reason != reason and reason != "statusline":
            self._pending_reason = "fs"
        self._debounce.start()

        if not self._max_wait.isActive():
            self._max_wait.start()

    @staticmethod
    def _classify_path(path: str) -> str:
        if path.endswith((".asm-statusline.json", ".csm-statusline.json")):
            return "statusline"
        try:
            rel = Path(path).resolve().relative_to(paths.projects_dir().resolve())
            if len(rel.parts) == 2 and rel.suffix == ".jsonl":
                return f"session:{rel.parts[0]}:{rel.stem}"
            if len(rel.parts) >= 2:
                return f"project:{rel.parts[0]}"
        except (OSError, ValueError):
            pass
        try:
            Path(path).resolve().relative_to(paths.codex_sessions_dir().resolve())
            return "codex"
        except (OSError, ValueError):
            pass
        return "fs"

    def _flush(self) -> None:
        self._debounce.stop()
        self._max_wait.stop()
        reason = self._pending_reason or "fs"
        self._pending_reason = None
        # The memoised walks are stale now; the next aggregate call re-lists.
        self._invalidate_all()
        self.dataChanged.emit(reason)

    # -- read slots --------------------------------------------------------- #

    @Slot(result=str)
    def getOverview(self) -> str:
        return _j({"projects": self._scanner.scan_projects(), "home": str(paths.claude_home())})

    @Slot(result=str)
    def getSources(self) -> str:
        return _j({"sources": [source.to_dict() for source in discover_sources()]})

    @Slot(result=str)
    def refreshSources(self) -> str:
        sources = refresh_sources()
        return _j({"sources": [source.to_dict() for source in sources]})

    @Slot(str, str, result=str)
    def getProviderOverview(self, provider: str, source_scope: str) -> str:
        projects: list[dict] = []
        source_rows = self._scope(source_scope)
        for source, claude, codex in source_rows:
            if provider in {"claude", "all"}:
                projects.extend(self._decorate(item, source, "claude", project=True) for item in claude.scan_projects())
            if provider in {"codex", "all"}:
                projects.extend(self._decorate(item, source, "codex", project=True) for item in codex.scan_projects())
        projects.sort(key=lambda item: item.get("last_activity", 0), reverse=True)
        home = ""
        if len(source_rows) == 1 and provider != "all":
            source, claude, codex = source_rows[0]
            home = claude.home if provider == "claude" else codex.home
        return _j({
            "provider": provider, "projects": projects, "home": str(home),
            "claude_home": str(paths.claude_home()), "codex_home": str(paths.codex_home()),
            "sources": [source.to_dict() for source, _c, _x in source_rows],
        })

    @Slot(result=str)
    def getAppInfo(self) -> str:
        return _j({
            "version": __version__,
            "platform": platform.system().lower(),
            "custom_window_controls": platform.system() == "Linux" and bool(os.environ.get("WSL_DISTRO_NAME")),
            "local_source": self._local_source_id,
            "async": True,
        })

    @Slot(bool, result=str)
    def checkForUpdate(self, force: bool) -> str:
        return self._start_update_job("check", force)

    @Slot(result=str)
    def installUpdate(self) -> str:
        return self._start_update_job("install", True)

    @Slot(result=str)
    def openReleasePage(self) -> str:
        return _j(actions.open_release_page())

    def _start_update_job(self, kind: str, force: bool) -> str:
        if self._update_busy:
            return _j({"ok": False, "error": "An update operation is already running"})
        self._update_busy = True
        threading.Thread(target=self._update_worker, args=(kind, force), daemon=True).start()
        return _j({"ok": True, "started": True, "kind": kind})

    def _update_worker(self, kind: str, force: bool) -> None:
        try:
            result = updater.download_and_run() if kind == "install" else updater.check(force=force)
            payload = {"ok": True, "kind": kind, **result}
        except Exception as exc:
            payload = {"ok": False, "kind": kind, "error": str(exc)}
        finally:
            self._update_busy = False
        self._deliverEvent.emit("update", _j(payload))

    @Slot(str, result=str)
    def getSessions(self, project_id: str) -> str:
        return _j({"sessions": self._scanner.list_sessions(project_id), "project": project_id})

    @Slot(str, str, result=str)
    def getProviderSessions(self, provider: str, project_id: str) -> str:
        source_id, native_id = self._split_project_id(project_id)
        pair = self._source_pair(source_id)
        if pair is None:
            return _j({"provider": provider, "sessions": [], "project": project_id, "error": "Source unavailable"})
        source, claude, codex = pair
        scanner = codex if provider == "codex" else claude
        sessions = [self._decorate(item, source, provider) for item in scanner.list_sessions(native_id)]
        for item in sessions:
            item["project_id"] = project_id
        return _j({"provider": provider, "sessions": sessions, "project": project_id})

    @Slot(str, str, result=str)
    def getSessionDetail(self, project_id: str, session_id: str) -> str:
        self._track_open((self._local_source_id, "claude", project_id, session_id))
        project_path = self._scanner.project_path(project_id)
        jsonl = paths.projects_dir() / project_id / f"{session_id}.jsonl"
        data = self._scanner.detail(jsonl) if jsonl.is_file() else {"events": [], "error": "not found"}
        data["tasks"] = self._scanner.get_tasks(session_id)
        scratch = self._scanner.get_scratchpad(project_path, session_id)
        data["scratchpad"] = scratch
        data["images"] = self._scanner.get_images(session_id)
        data["file_history"] = self._scanner.get_file_history(session_id)
        data["session_id"] = session_id
        data["project_id"] = project_id
        # Live-watch this session's workspace while it's open.
        self._watcher.watch_scratchpad(scratch.get("dir") or None)
        return _j(data)

    @Slot(str, str, str, result=str)
    def getProviderSessionDetail(self, provider: str, project_id: str, session_id: str) -> str:
        source_id, native_id = self._split_project_id(project_id)
        pair = self._source_pair(source_id)
        if pair is None:
            return _j({"events": [], "error": "Source unavailable"})
        source, claude, codex = pair
        self._track_open((source_id, provider, native_id, session_id))
        if provider == "codex":
            data = codex.detail(native_id, session_id)
            path = codex.session_path(native_id, session_id)
            data.update({
                "path": str(path) if path else "", "tasks": [], "scratchpad": {"files": []},
                "images": [], "file_history": [], "session_id": session_id, "project_id": project_id,
            })
            if source_id == self._local_source_id:
                self._watcher.watch_scratchpad(None)
        else:
            project_path = claude.project_path(native_id)
            jsonl = claude.projects_root / native_id / f"{session_id}.jsonl"
            data = claude.detail(jsonl) if jsonl.is_file() else {"events": [], "error": "not found"}
            data.update({
                "provider": "claude", "path": str(jsonl),
                "tasks": claude.get_tasks(session_id),
                "scratchpad": claude.get_scratchpad(project_path, session_id),
                "images": claude.get_images(session_id),
                "file_history": claude.get_file_history(session_id),
                "session_id": session_id, "project_id": project_id,
            })
            if source_id == self._local_source_id:
                self._watcher.watch_scratchpad(data["scratchpad"].get("dir") or None)
        data.update({"source_id": source.id, "source_label": source.label, "source_kind": source.kind})
        return _j(data)

    @Slot(str, str, str, result=str)
    def getSessionMeta(self, provider: str, project_id: str, session_id: str) -> str:
        """Aggregates only — what a live refresh of an open session needs."""
        source_id, native_id = self._split_project_id(project_id)
        pair = self._source_pair(source_id)
        if pair is None:
            return _j({"error": "Source unavailable"})
        _source, claude, codex = pair
        if provider == "codex":
            data = codex.detail_meta(native_id, session_id)
        else:
            jsonl = claude.projects_root / native_id / f"{session_id}.jsonl"
            data = claude.detail_meta(jsonl) if jsonl.is_file() else {"error": "not found"}
            data["tasks"] = claude.get_tasks(session_id)
        data.update({"session_id": session_id, "project_id": project_id, "provider": provider})
        return _j(data)

    def _track_open(self, key: tuple[str, str, str, str]) -> None:
        with self._open_lock:
            previous = self._open_session
            self._open_session = key
        if previous and previous != key:
            self._release(previous)

    def _release(self, key: tuple[str, str, str, str]) -> None:
        source_id, provider, project_id, session_id = key
        pair = self._source_pair(source_id)
        if pair is None:
            return
        _source, claude, codex = pair
        if provider == "codex":
            codex.release_detail(project_id, session_id)
        else:
            claude.release_detail(project_id, session_id)

    @Slot()
    def leaveSession(self) -> None:
        """Release session-specific watches when the inspector is closed."""
        with self._open_lock:
            previous = self._open_session
            self._open_session = None
        if previous:
            self._release(previous)
        self._watcher.watch_scratchpad(None)

    @Slot(str, str, int, int, result=str)
    def getTranscriptBefore(self, project_id: str, session_id: str, before: int, count: int) -> str:
        jsonl = paths.projects_dir() / project_id / f"{session_id}.jsonl"
        return _j(self._scanner.transcript_before(jsonl, before, count))

    @Slot(str, str, int, result=str)
    def getTranscriptAfter(self, project_id: str, session_id: str, after: int) -> str:
        jsonl = paths.projects_dir() / project_id / f"{session_id}.jsonl"
        return _j(self._scanner.transcript_after(jsonl, after))

    @Slot(str, str, str, int, int, result=str)
    def getProviderTranscriptBefore(self, provider: str, project_id: str, session_id: str, before: int, count: int) -> str:
        source_id, native_id = self._split_project_id(project_id)
        pair = self._source_pair(source_id)
        if pair is None:
            return _j({"events": [], "error": "Source unavailable"})
        _source, claude, codex = pair
        if provider == "codex":
            return _j(codex.transcript_before(native_id, session_id, before, count))
        return _j(claude.transcript_before(claude.projects_root / native_id / f"{session_id}.jsonl", before, count))

    @Slot(str, str, str, int, result=str)
    def getProviderTranscriptAfter(self, provider: str, project_id: str, session_id: str, after: int) -> str:
        source_id, native_id = self._split_project_id(project_id)
        pair = self._source_pair(source_id)
        if pair is None:
            return _j({"events": [], "error": "Source unavailable"})
        _source, claude, codex = pair
        if provider == "codex":
            return _j(codex.transcript_after(native_id, session_id, after))
        return _j(claude.transcript_after(claude.projects_root / native_id / f"{session_id}.jsonl", after))

    @Slot(str, result=str)
    def searchAll(self, query: str) -> str:
        return _j(self._scanner.search_all(query))

    @Slot(str, str, str, result=str)
    def searchProvider(self, provider: str, source_scope: str, query: str) -> str:
        sessions: list[dict] = []
        prompts: list[dict] = []
        for source, claude, codex in self._scope(source_scope):
            scanners = (("claude", claude), ("codex", codex)) if provider == "all" else ((provider, codex if provider == "codex" else claude),)
            for agent, scanner in scanners:
                data = scanner.search_all(query)
                sessions.extend(self._decorate(item, source, agent) for item in data.get("sessions", []))
                prompts.extend(self._decorate(item, source, agent) for item in data.get("prompts", []))
        sessions.sort(key=lambda item: item.get("mtime", 0), reverse=True)
        prompts.sort(key=lambda item: item.get("timestamp", 0), reverse=True)
        return _j({"provider": provider, "sessions": sessions[:100], "prompts": prompts[:100]})

    @Slot(result=str)
    def getShells(self) -> str:
        return _j(self._scanner.get_shells())

    @Slot(result=str)
    def getGlobalStats(self) -> str:
        return _j(self._scanner.global_stats())

    @Slot(str, str, result=str)
    def getProviderGlobalStats(self, provider: str, source_scope: str) -> str:
        rows: list[tuple[str, str, dict]] = []
        for source, claude, codex in self._scope(source_scope):
            if provider in {"claude", "all"}:
                rows.append((source.id, "claude", claude.global_stats()))
            if provider in {"codex", "all"}:
                rows.append((source.id, "codex", codex.global_stats()))
        return _j(_merge_stats(provider, rows))

    @Slot(str, str, int, result=str)
    def getTrace(self, provider: str, source_scope: str, limit: int) -> str:
        """Skills invoked, agents spawned, kills and interruptions, machine-wide."""
        events: list[dict] = []
        limit = max(50, min(int(limit or 500), 5000))
        for source, claude, codex in self._scope(source_scope):
            scanners = (("claude", claude), ("codex", codex)) if provider == "all" else ((provider, codex if provider == "codex" else claude),)
            for agent, scanner in scanners:
                events.extend(self._decorate(item, source, agent) for item in scanner.trace_events(limit))
        events.sort(key=lambda row: row.get("t", 0), reverse=True)
        return _j({"provider": provider, "events": events[:limit], "limit": limit})

    @Slot(result=str)
    def getAllSessions(self) -> str:
        return _j(self._scanner.all_sessions())

    @Slot(str, str, result=str)
    def getProviderAllSessions(self, provider: str, source_scope: str) -> str:
        sessions: list[dict] = []
        source_totals: list[dict] = []
        for source, claude, codex in self._scope(source_scope):
            scanners = (("claude", claude), ("codex", codex)) if provider == "all" else ((provider, codex if provider == "codex" else claude),)
            for agent, scanner in scanners:
                data = scanner.all_sessions()
                rows = [self._decorate(item, source, agent) for item in data.get("sessions", [])]
                sessions.extend(rows)
                source_totals.append({"source_id": source.id, "source_label": source.label, "provider": agent, "bytes": data.get("total_bytes", 0), "sessions": len(rows)})
        sessions.sort(key=lambda item: item.get("size_bytes", 0) + item.get("extra_bytes", 0), reverse=True)
        return _j({"provider": provider, "sessions": sessions, "home": "", "total_bytes": sum(item["bytes"] for item in source_totals), "cost_available": provider == "claude", "source_totals": source_totals})

    @Slot(str, result=str)
    def getStorageAssets(self, source_scope: str) -> str:
        items: list[dict] = []
        for source, claude, _codex in self._scope(source_scope):
            data = claude.storage_assets()
            for item in data.get("items", []):
                row = self._decorate(item, source, "claude")
                row["source_writable"] = source.id == self._local_source_id
                items.append(row)
        items.sort(key=lambda item: item.get("size_bytes", 0), reverse=True)
        return _j({"items": items, "total_bytes": sum(item.get("size_bytes", 0) for item in items)})

    @Slot(str, result=str)
    def getMemory(self, project_id: str) -> str:
        source_id, native_id = self._split_project_id(project_id)
        pair = self._source_pair(source_id)
        if pair is None:
            return _j({"files": [], "error": "Source unavailable"})
        source, claude, _codex = pair
        data = claude.get_memory(native_id)
        data.update({"source_id": source.id, "source_label": source.label, "source_writable": source.id == self._local_source_id})
        return _j(data)

    @Slot(result=str)
    def getSettings(self) -> str:
        return _j(self._scanner.get_settings())

    @Slot(result=str)
    def getStatuslineLive(self) -> str:
        return _j(self._scanner.get_statusline_live() or {})

    @Slot(str, result=str)
    def readFile(self, path: str) -> str:
        return _j(actions.read_text_file(path))

    # -- write / action slots ---------------------------------------------- #

    @Slot(str, str, result=str)
    def saveMemory(self, path: str, content: str) -> str:
        return _j(actions.save_memory(path, content))

    @Slot(str, result=str)
    def deleteMemory(self, path: str) -> str:
        return _j(actions.delete_memory(path))

    @Slot(str, str, bool, result=str)
    def deleteSession(self, project_id: str, session_id: str, purge: bool) -> str:
        return _j(actions.delete_session(project_id, session_id, purge))

    @Slot(str, bool, result=str)
    def deleteSessions(self, items_json: str, purge: bool) -> str:
        try:
            items = json.loads(items_json)
        except json.JSONDecodeError:
            items = []
        return _j(actions.delete_sessions(items, purge))

    @Slot(str, result=str)
    def deleteScratchpadFile(self, path: str) -> str:
        return _j(actions.delete_scratchpad_file(path))

    @Slot(str, result=str)
    def openInEditor(self, path: str) -> str:
        return _j(actions.open_in_editor(path))

    @Slot(str, result=str)
    def openPath(self, path: str) -> str:
        return _j(actions.open_path(path))

    @Slot(str, str, result=str)
    def launchClaude(self, project_path: str, session_id: str) -> str:
        return _j(actions.launch_claude(project_path, session_id))

    @Slot(str, str, str, str, str, result=str)
    def launchAgent(self, provider: str, source_id: str, project_path: str, session_id: str, mode: str) -> str:
        source = source_by_id(source_id, resolve=True)
        if source is None or not source.available:
            return _j({"ok": False, "error": "Source unavailable"})
        if source.kind == "wsl":
            return _j(actions.launch_wsl_session(source.distro, provider, project_path, session_id, mode))
        return _j(actions.launch_session(provider, project_path, session_id, mode))

    @Slot(str, result=str)
    def archiveCodexSession(self, session_id: str) -> str:
        path = self._codex.session_path(session_id)
        if path is None:
            return _j({"ok": False, "error": "Session not found"})
        try:
            if path.is_file() and time.time() - path.stat().st_mtime <= 600:
                return _j({"ok": False, "error": "Session had activity in the last 10 minutes; archive is temporarily blocked"})
        except OSError:
            pass
        return _j(actions.archive_codex_session(session_id))

    @Slot(str, bool, result=str)
    def cleanupSessions(self, items_json: str, purge: bool) -> str:
        try:
            items = json.loads(items_json)
        except json.JSONDecodeError:
            items = []
        results = []
        for item in items if isinstance(items, list) else []:
            provider = (item or {}).get("provider", "claude")
            source_id = (item or {}).get("source_id", self._local_source_id)
            sid = (item or {}).get("session_id", "")
            pid = (item or {}).get("project_id", "")
            parsed_source, native_pid = self._split_project_id(pid)
            if source_id != parsed_source:
                result = {"ok": False, "error": "Source identity mismatch"}
                results.append({"provider": provider, "source_id": source_id, "project_id": pid, "session_id": sid, **result})
                continue
            pair = self._source_pair(source_id)
            if pair is None:
                result = {"ok": False, "error": "Source unavailable"}
                results.append({"provider": provider, "source_id": source_id, "project_id": pid, "session_id": sid, **result})
                continue
            source, claude, codex = pair
            if provider == "codex":
                path = codex.session_path(native_pid, sid)
                try:
                    protected = path is not None and path.is_file() and time.time() - path.stat().st_mtime <= 600
                except OSError:
                    protected = False
                if protected:
                    result = {"ok": False, "error": "Recently active"}
                elif source.kind == "wsl":
                    result = actions.archive_wsl_codex_session(source.distro, sid)
                else:
                    result = actions.archive_codex_session(sid)
            else:
                result = actions.delete_session(native_pid, sid, purge) if source.id == self._local_source_id else {"ok": False, "error": "WSL Claude cleanup is read-only for safety"}
            results.append({"provider": provider, "source_id": source_id, "project_id": pid, "session_id": sid, **result})
        completed = sum(1 for item in results if item.get("ok"))
        self._invalidate_all()
        return _j({"ok": completed > 0, "completed": completed, "count": len(results), "results": results})

    def _invalidate_all(self) -> None:
        for pair in list(self._source_scanners.values()):
            for scanner in pair:
                try:
                    scanner.invalidate()
                except Exception:
                    pass

    @Slot(str, result=str)
    def deleteStorageAssets(self, items_json: str) -> str:
        try:
            requested = json.loads(items_json)
        except json.JSONDecodeError:
            requested = []
        local_pair = self._source_pair(self._local_source_id)
        if local_pair is None:
            return _j({"ok": False, "completed": 0, "results": []})
        _source, claude, _codex = local_pair
        inventory = claude.storage_assets().get("items", [])
        allowed = {item["path"] for item in inventory if not item.get("protected")}
        by_identity = {(item.get("kind"), item.get("session_id"), item.get("path")): item for item in inventory}
        results = []
        for req in requested if isinstance(requested, list) else []:
            if req.get("source_id") != self._local_source_id:
                result = {"ok": False, "error": "Only Windows assets are writable"}
            else:
                key = (req.get("kind"), req.get("session_id"), req.get("path"))
                item = by_identity.get(key)
                result = actions.delete_inventory_path(item["path"], allowed) if item and not item.get("protected") else {"ok": False, "error": "Asset is protected or no longer present"}
            results.append({**req, **result})
        completed = sum(1 for item in results if item.get("ok"))
        self._invalidate_all()
        return _j({"ok": completed > 0, "completed": completed, "count": len(results), "results": results})

    @Slot(str, str, result=str)
    def updateSetting(self, key: str, value_json: str) -> str:
        try:
            value = json.loads(value_json)
        except json.JSONDecodeError:
            value = value_json
        return _j(actions.update_setting(key, value))

    @Slot(str, result=str)
    def updateSettings(self, items_json: str) -> str:
        """Apply many edits at once (each ``{"key","value"}``; null value = delete)."""
        try:
            items = json.loads(items_json)
        except json.JSONDecodeError:
            items = []
        return _j(actions.update_settings(items))

    @Slot(result=str)
    def listConfigFiles(self) -> str:
        return _j({"files": actions.list_config_files()})

    @Slot(result=str)
    def getCodexSettings(self) -> str:
        config = paths.codex_config_file()
        return _j({"provider": "codex", "home": str(paths.codex_home()), "config": str(config), "exists": config.is_file()})

    @Slot(str, result=str)
    def listCodexConfigFiles(self, project_path: str) -> str:
        return _j({"files": actions.list_codex_config_files(project_path)})

    @Slot(str, str, result=str)
    def writeClaudeFile(self, path: str, content: str) -> str:
        return _j(actions.write_claude_file(path, content))

    @Slot(str, str, str, result=str)
    def writeCodexFile(self, path: str, content: str, project_path: str) -> str:
        return _j(actions.write_codex_file(path, content, project_path))

    # -- window controls (WSLg title bars can be nearly invisible) ---------- #

    @Slot()
    def windowMinimize(self) -> None:
        if self._window is not None:
            self._window.showMinimized()

    @Slot()
    def windowClose(self) -> None:
        if self._window is not None:
            self._window.close()

    # -- CLAUDE.md guidance & consolidation -------------------------------- #

    @Slot(str, str, result=str)
    def getGuidance(self, scope: str, project_path: str) -> str:
        return _j(actions.read_guidance(scope, project_path))

    @Slot(str, str, str, result=str)
    def saveGuidance(self, scope: str, content: str, project_path: str) -> str:
        return _j(actions.write_guidance(scope, content, project_path))

    @Slot(str, str, result=str)
    def writeMemoryNotes(self, project_id: str, notes_json: str) -> str:
        try:
            notes = json.loads(notes_json)
        except json.JSONDecodeError:
            notes = []
        source_id, native_id = self._split_project_id(project_id)
        if source_id != self._local_source_id:
            return _j({"ok": False, "error": "WSL memory is read-only"})
        return _j(actions.write_memory_notes(native_id, notes))

    @Slot(str, result=str)
    def startAssistant(self, req_json: str) -> str:
        """Launch a headless ``claude`` job. Returns a job_id immediately; the
        result arrives later via the ``assistantEvent`` signal so the UI never
        blocks on the (multi-second) model call."""
        try:
            req = json.loads(req_json)
        except json.JSONDecodeError:
            return _j({"ok": False, "error": "bad request"})
        if len(self._jobs) >= 2:
            return _j({"ok": False, "error": "Two optimization jobs are already running"})
        binp = assistant.claude_bin()
        if not binp:
            return _j({"ok": False, "error": "The 'claude' CLI was not found. Install Claude Code and sign in."})

        kind = req.get("kind", "tune")
        summaries: list[dict] = []
        grouped: dict[str, list[dict]] = {}
        for item in req.get("sessions") or []:
            source_id, native_id = self._split_project_id(str((item or {}).get("project_id", "")))
            grouped.setdefault(source_id, []).append({**item, "project_id": native_id})
        for source_id, items in grouped.items():
            pair = self._source_pair(source_id)
            if pair is not None:
                summaries.extend(pair[1].summaries_for(items))
        if kind == "consolidate":
            prompt = assistant.build_consolidate_prompt(req, summaries)
        else:
            prompt = assistant.build_tune_prompt(req, summaries)

        job_id = uuid4().hex
        proc = QProcess(self)
        proc.setProgram(binp)
        # Read the prompt from stdin. Passing a full multi-session prompt as one
        # argv value exceeds Windows' command-line limit surprisingly quickly.
        proc.setArguments(["-p", "--output-format", "json"])
        proc.started.connect(lambda p=proc, data=prompt.encode("utf-8"): (p.write(data), p.closeWriteChannel()))
        proc.finished.connect(lambda code, _status, jid=job_id: self._assistant_finished(jid, code))
        proc.errorOccurred.connect(lambda _e, jid=job_id: self._assistant_error(jid))
        timer = QTimer(proc)
        timer.setSingleShot(True)
        timer.setInterval(15 * 60 * 1000)
        timer.timeout.connect(lambda jid=job_id: self._assistant_timeout(jid))
        self._jobs[job_id] = (proc, kind, timer)
        proc.start()
        timer.start()
        return _j({"ok": True, "job_id": job_id})

    def _assistant_finished(self, job_id: str, code: int) -> None:
        entry = self._jobs.pop(job_id, None)
        if entry is None:
            return
        proc, kind, timer = entry
        timer.stop()
        out = bytes(proc.readAllStandardOutput()).decode("utf-8", "replace")
        err = bytes(proc.readAllStandardError()).decode("utf-8", "replace")
        result = assistant.parse_result(out, err, code)
        # Consolidate returns a JSON array of notes — parse it here (tolerant of
        # code fences / stray prose) so the UI receives ready-to-write records.
        if kind == "consolidate" and result.get("ok"):
            result["notes"] = assistant.parse_memory_notes(result.get("text") or "")
        result["kind"] = kind
        result["job_id"] = job_id
        result["status"] = "done" if result.get("ok") else "error"
        self.assistantEvent.emit(_j(result))

    def _assistant_error(self, job_id: str) -> None:
        entry = self._jobs.pop(job_id, None)
        if entry is None:
            return
        proc, _kind, timer = entry
        timer.stop()
        self.assistantEvent.emit(_j({
            "job_id": job_id, "status": "error",
            "ok": False, "error": proc.errorString() or "failed to start claude",
        }))

    def _assistant_timeout(self, job_id: str) -> None:
        entry = self._jobs.pop(job_id, None)
        if entry is None:
            return
        proc, _kind, _timer = entry
        proc.kill()
        self.assistantEvent.emit(_j({
            "job_id": job_id, "status": "error", "ok": False,
            "error": "Optimization timed out after 15 minutes",
        }))

    @Slot(str, result=str)
    def cancelAssistant(self, job_id: str) -> str:
        entry = self._jobs.pop(job_id, None)
        if entry is None:
            return _j({"ok": False, "error": "job not found"})
        proc, _kind, timer = entry
        timer.stop()
        proc.kill()
        return _j({"ok": True, "job_id": job_id})

    @Slot(result=str)
    def statuslineStatus(self) -> str:
        return _j(actions.statusline_capture_status())

    @Slot(result=str)
    def installStatusline(self) -> str:
        return _j(actions.install_statusline_capture())

    @Slot(result=str)
    def uninstallStatusline(self) -> str:
        return _j(actions.uninstall_statusline_capture())


# --------------------------------------------------------------------------- #
# Aggregation across sources and providers                                     #
# --------------------------------------------------------------------------- #

_EMPTY_DAY = {"cost": 0.0, "tokens": 0, "turns": 0, "prompts": 0, "errors": 0, "active_ms": 0, "sessions": 0}


def _merge_stats(provider: str, rows: list[tuple[str, str, dict]]) -> dict:
    """Fold per-source, per-provider stats into one payload.

    Kept as a module function so it can be exercised without Qt.
    """
    usage: dict = {}
    by_model: dict = {}
    tools: Counter = Counter()
    days: Counter = Counter()
    daily: dict[str, dict] = {}
    heat = [[0] * 24 for _ in range(7)]
    by_project: list[dict] = []
    tables: dict[str, dict] = {"skills": {}, "agents": {}, "commands": {}}
    result: dict = {
        "provider": provider, "cost": 0.0,
        "cost_available": provider == "claude", "usage": usage,
        "by_model": by_model, "tool_counts": {}, "sessions_by_day": [],
        "activity": heat, "sources": [], "first_activity": "",
    }
    for source_id, agent, data in rows:
        result["sources"].append({"source_id": source_id, "provider": agent, "sessions": data.get("sessions", 0)})
        if agent == "claude":
            result["cost"] += float(data.get("cost", 0) or 0)
        for key, value in data.get("usage", {}).items():
            usage[key] = int(usage.get(key, 0)) + int(value or 0)
        for model, values in data.get("by_model", {}).items():
            bucket = by_model.setdefault(model, {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "total": 0, "cost": 0.0, "provider": agent})
            for key in ("input", "output", "cache_read", "cache_write", "reasoning_output", "total"):
                bucket[key] = bucket.get(key, 0) + int(values.get(key, 0) or 0)
            bucket["cost"] += float(values.get("cost", 0) or 0)
        tools.update(data.get("tool_counts", {}))
        days.update(dict(data.get("sessions_by_day", [])))
        for row, source_row in zip(heat, data.get("activity") or []):
            for hour, count in enumerate(source_row[:24]):
                row[hour] += int(count or 0)
        for key in ("sessions", "active", "prompts", "turns", "tool_calls", "subagent_sessions",
                    "tool_errors", "compactions", "active_ms", "kills", "interrupts"):
            result[key] = int(result.get(key, 0)) + int(data.get(key, 0) or 0)
        result["cache_savings"] = round(float(result.get("cache_savings", 0)) + float(data.get("cache_savings", 0) or 0), 4)
        for pid, pdays in (data.get("project_daily") or {}).items():
            key = pid if pid == "other" else f"{source_id}::{pid}"
            bucket = result.setdefault("project_daily", {}).setdefault(key, {})
            for day, value in pdays.items():
                bucket[day] = round(bucket.get(day, 0.0) + float(value or 0), 4)
        first = data.get("first_activity") or ""
        if first and (not result["first_activity"] or first < result["first_activity"]):
            result["first_activity"] = first
        for day in data.get("daily") or []:
            bucket = daily.setdefault(day["d"], {"d": day["d"], **_EMPTY_DAY, "models": {}})
            for key in _EMPTY_DAY:
                bucket[key] += day.get(key, 0) or 0
            for model, model_cost in (day.get("models") or {}).items():
                bucket["models"][model] = bucket["models"].get(model, 0.0) + float(model_cost or 0)
        for project in data.get("by_project") or []:
            by_project.append({**project, "provider": agent, "source_id": source_id,
                               "id": f"{source_id}::{project.get('id', '')}"})
        for table in tables:
            for name, row in (data.get(table) or {}).items():
                bucket = tables[table].setdefault(name, {"count": 0, "sessions": 0, "projects": 0, "last": 0.0, "providers": []})
                bucket["count"] += int(row.get("count", 0) or 0)
                bucket["sessions"] += int(row.get("sessions", 0) or 0)
                bucket["projects"] += int(row.get("projects", 0) or 0)
                bucket["last"] = max(bucket["last"], float(row.get("last", 0) or 0))
                if agent not in bucket["providers"]:
                    bucket["providers"].append(agent)
    result["cost"] = round(result["cost"], 4)
    result["tool_counts"] = dict(tools.most_common(24))
    result["sessions_by_day"] = sorted(days.items())[-90:]
    result["daily"] = [dict(daily[key], cost=round(daily[key]["cost"], 4)) for key in sorted(daily)][-90:]
    by_project.sort(key=lambda item: item.get("last_activity", 0), reverse=True)
    result["by_project"] = by_project
    result.update(tables)
    return result
