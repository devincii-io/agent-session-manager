"""The bridge's asynchronous lane.

Every read the frontend makes goes through ``invoke``: it returns at once and
the answer comes back through ``replied`` from a worker thread, delivered on
the GUI thread. These tests drive a headless ``QCoreApplication`` to prove the
lane round-trips, never blocks the event loop, and drops superseded requests.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QCoreApplication, QEventLoop, QTimer  # noqa: E402

from asm import bridge as bridge_module  # noqa: E402
from asm.scanner import Scanner  # noqa: E402


class _FakeWatcher:
    def __init__(self) -> None:
        self.fileEvent = _Signal()

    def watch_scratchpad(self, _path) -> None:
        pass


class _Signal:
    def connect(self, _fn) -> None:
        pass


def _app() -> QCoreApplication:
    return QCoreApplication.instance() or QCoreApplication([])


def _wait_for(predicate, timeout_ms: int = 5000) -> None:
    loop = QEventLoop()
    deadline = time.monotonic() + timeout_ms / 1000
    timer = QTimer()
    timer.setInterval(5)
    timer.timeout.connect(lambda: (predicate() or time.monotonic() > deadline) and loop.quit())
    timer.start()
    loop.exec()
    timer.stop()


class AsyncBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = _app()
        self.tmp = tempfile.TemporaryDirectory()
        home = Path(self.tmp.name) / ".claude"
        (home / "projects" / "-work").mkdir(parents=True)
        record = {"type": "user", "timestamp": "2026-08-01T10:00:00.000Z", "cwd": "/work",
                  "message": {"role": "user", "content": [{"type": "text", "text": "hello"}]}}
        (home / "projects" / "-work" / "one.jsonl").write_text(json.dumps(record) + "\n", "utf-8")
        self.patches = [
            patch("asm.paths.claude_home", return_value=home),
            patch("asm.paths.cache_dir", return_value=Path(self.tmp.name) / "cache"),
            patch("asm.paths.codex_home", return_value=Path(self.tmp.name) / ".codex"),
        ]
        for item in self.patches:
            item.start()
        scanner = Scanner(home, cache_namespace="bridge-test", temp_roots=[])
        self.bridge = bridge_module.Bridge(scanner, _FakeWatcher())
        self.replies: dict[str, dict] = {}
        self.bridge.replied.connect(lambda rid, payload: self.replies.__setitem__(rid, json.loads(payload)))

    def tearDown(self) -> None:
        self.bridge.shutdown()
        for item in self.patches:
            item.stop()
        self.tmp.cleanup()

    def test_invoke_answers_on_the_event_loop_without_blocking_it(self) -> None:
        ticks = []
        pulse = QTimer()
        pulse.setInterval(1)
        pulse.timeout.connect(lambda: ticks.append(time.monotonic()))
        pulse.start()
        self.bridge.invoke("r1", "getProviderOverview", json.dumps(["claude", json.dumps(["windows", "local"])]))
        self.assertNotIn("r1", self.replies, "invoke must return before the work is done")
        _wait_for(lambda: "r1" in self.replies)
        pulse.stop()
        projects = self.replies["r1"]["projects"]
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0]["session_count"], 1)
        self.assertGreater(len(ticks), 0, "the event loop kept turning while the scan ran")

    def test_unknown_methods_and_private_names_are_refused(self) -> None:
        self.bridge.invoke("r2", "_work", "[]")
        self.bridge.invoke("r3", "doesNotExist", "[]")
        _wait_for(lambda: "r2" in self.replies and "r3" in self.replies)
        self.assertFalse(self.replies["r2"]["ok"])
        self.assertFalse(self.replies["r3"]["ok"])

    def test_a_superseded_request_is_answered_stale(self) -> None:
        scope = json.dumps(["windows", "local"])
        # Two of the same coalescing method back to back: only the newest
        # should do work; the older may be answered stale.
        self.bridge.invoke("old", "getProviderGlobalStats", json.dumps(["claude", scope]))
        self.bridge.invoke("new", "getProviderGlobalStats", json.dumps(["claude", scope]))
        _wait_for(lambda: "old" in self.replies and "new" in self.replies)
        self.assertNotIn("stale", self.replies["new"])
        self.assertEqual(self.replies["new"]["sessions"], 1)

    def test_main_thread_methods_answer_inline(self) -> None:
        self.bridge.invoke("info", "getAppInfo", "[]")
        self.assertIn("info", self.replies, "getAppInfo needs no worker and answers at once")
        self.assertTrue(self.replies["info"]["async"])


class MergeStatsTests(unittest.TestCase):
    def test_sources_and_providers_fold_into_one_payload(self) -> None:
        claude = {
            "cost": 1.5, "usage": {"total": 100, "input": 40}, "sessions": 2, "active_ms": 1000,
            "by_model": {"claude-opus-4-8": {"total": 100, "cost": 1.5}},
            "tool_counts": {"Bash": 3}, "sessions_by_day": [["2026-08-01", 2]],
            "activity": [[1] * 24] * 7,
            "daily": [{"d": "2026-08-01", "cost": 1.5, "tokens": 100, "turns": 2, "prompts": 1,
                       "errors": 0, "active_ms": 1000, "sessions": 2, "models": {"claude-opus-4-8": 1.5}}],
            "by_project": [{"id": "-work", "name": "work", "cost": 1.5}],
            "skills": {"unslop": {"count": 2, "sessions": 1, "projects": 1, "last": 5.0}},
            "agents": {}, "commands": {}, "kills": 1, "interrupts": 0,
        }
        codex = {
            "cost": 0.0, "usage": {"total": 30, "input": 30}, "sessions": 1, "active_ms": 500,
            "by_model": {"gpt-test": {"total": 30, "cost": 0.0}}, "tool_counts": {"shell": 1},
            "sessions_by_day": [["2026-08-01", 1]], "activity": [[0] * 24] * 7,
            "daily": [{"d": "2026-08-01", "cost": 0.0, "tokens": 30, "turns": 1, "prompts": 1,
                       "errors": 1, "active_ms": 500, "sessions": 1, "models": {}}],
            "by_project": [{"id": "codex-1", "name": "work", "cost": 0.0}],
            "skills": {}, "agents": {"spawn_agent": {"count": 1, "sessions": 1, "projects": 1, "last": 9.0}},
            "commands": {}, "kills": 0, "interrupts": 2,
        }
        merged = bridge_module._merge_stats("all", [("windows", "claude", claude), ("windows", "codex", codex)])
        self.assertEqual(merged["sessions"], 3)
        self.assertEqual(merged["cost"], 1.5)
        self.assertEqual(merged["active_ms"], 1500)
        self.assertEqual(merged["kills"], 1)
        self.assertEqual(merged["interrupts"], 2)
        self.assertEqual(merged["daily"][0]["tokens"], 130)
        self.assertEqual(merged["daily"][0]["errors"], 1)
        self.assertEqual(merged["skills"]["unslop"]["count"], 2)
        self.assertEqual(merged["agents"]["spawn_agent"]["providers"], ["codex"])
        self.assertEqual({project["provider"] for project in merged["by_project"]}, {"claude", "codex"})
        self.assertEqual(merged["by_project"][0]["id"], "windows::-work")


if __name__ == "__main__":
    unittest.main()
