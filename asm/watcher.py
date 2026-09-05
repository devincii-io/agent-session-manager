"""Filesystem watcher that turns local agent session changes into Qt signals.

One watchdog observer, a handful of narrow watches. The Claude home is *not*
watched recursively as a whole: ``plugins/``, ``chrome/``, ``daemon.log``,
``paste-cache/`` and friends churn constantly and none of it changes anything
the app shows. Only the transcript tree, the task boards, the settings files
and the statusline capture are watched, plus the Codex rollout archive. A
caller can additionally watch a specific scratchpad directory while a session
is open. Raw events are coalesced downstream (the bridge debounces before
re-scanning).
"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QObject, Signal
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from . import paths

#: Files the app itself writes, or editors leave behind, that are never data.
_IGNORED_SUFFIXES = (".tmp", ".swp", ".lock", "~")
#: Top-level files under the Claude home worth reacting to.
_HOME_FILES = {"settings.json", "settings.local.json", ".asm-statusline.json", ".csm-statusline.json", "history.jsonl"}


class _Handler(FileSystemEventHandler):
    def __init__(self, emit, *, only_files: set[str] | None = None) -> None:
        super().__init__()
        self._emit = emit
        self._only = only_files

    def on_any_event(self, event) -> None:  # noqa: ANN001
        try:
            src = str(getattr(event, "src_path", "") or "")
            if not src or src.endswith(_IGNORED_SUFFIXES):
                return
            if self._only is not None and Path(src).name not in self._only:
                return
            self._emit(src)
        except Exception:
            pass


class Watcher(QObject):
    """Emits :attr:`fileEvent` (queued to the GUI thread) on any watched change."""

    fileEvent = Signal(str)

    def __init__(self) -> None:
        super().__init__()
        self._observer = Observer()
        self._handler = _Handler(self._on_event)
        self._home_handler = _Handler(self._on_event, only_files=_HOME_FILES)
        self._extra_watch = None

    def _on_event(self, path: str) -> None:
        # Signal emission is thread-safe; delivery is queued to the GUI thread.
        self.fileEvent.emit(path)

    def _schedule(self, handler, directory: Path, *, recursive: bool) -> None:
        if directory.is_dir():
            try:
                self._observer.schedule(handler, str(directory), recursive=recursive)
            except Exception:
                pass

    def start(self) -> None:
        # Never let a watch failure (e.g. UNC/network paths on Windows) kill
        # the app — live updates degrade to manual refresh instead.
        try:
            home = paths.claude_home()
            self._schedule(self._home_handler, home, recursive=False)
            self._schedule(self._handler, home / "projects", recursive=True)
            self._schedule(self._handler, home / "tasks", recursive=True)
            # Watch only rollouts. Watching all of ~/.codex would include
            # SQLite WAL, browser, plugin, and cache churn unrelated to the
            # session workbench.
            self._schedule(self._handler, paths.codex_sessions_dir(), recursive=True)
            self._observer.start()
        except Exception:
            pass

    def watch_scratchpad(self, scratchpad_dir: str | None) -> None:
        """Watch a scratchpad directory in addition to the Claude home tree."""
        if self._extra_watch is not None:
            try:
                self._observer.unschedule(self._extra_watch)
            except Exception:
                pass
            self._extra_watch = None
        if scratchpad_dir:
            p = Path(scratchpad_dir)
            if p.is_dir():
                try:
                    self._extra_watch = self._observer.schedule(self._handler, str(p), recursive=True)
                except Exception:
                    self._extra_watch = None

    def stop(self) -> None:
        try:
            self._observer.stop()
            self._observer.join(timeout=2)
        except Exception:
            pass
